import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db";
import { accounts, sessions, users, verifications } from "@/lib/db/schema";
import { actionEmail, sendEmail } from "@/lib/email";

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Better Auth on our own Neon tables (users/sessions/accounts/verifications).
 * - Sign-ups are closed: people join through an owner's invite (lib/services/users.ts).
 * - Password and magic-link sign-in for existing users; reset creates a password if the user has none.
 * - Disabled users can't start a session.
 */
export function createAuth(db: Db, opts: { baseURL?: string; secret?: string; nextjs?: boolean } = {}) {
  return betterAuth({
    appName: "Social Planner",
    baseURL: opts.baseURL ?? process.env.BETTER_AUTH_URL ?? process.env.APP_URL,
    secret: opts.secret ?? process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db as unknown as Record<string, unknown>, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    user: {
      additionalFields: {
        role: { type: "string", required: false, input: false, defaultValue: "client" },
        externalUserId: { type: "string", required: false, input: false },
        disabledAt: { type: "date", required: false, input: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Set your Social Planner password",
          ...actionEmail({ heading: "Set a new password", body: "Use the button below to choose a new password. The link works once and expires in 1 hour.", cta: "Choose password", url, footnote: "Didn't ask for this? You can ignore this email." }),
        });
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [u] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, session.userId));
            if (u?.disabledAt) throw new APIError("FORBIDDEN", { message: "This account has been disabled. Ask an owner to re-enable it." });
          },
        },
      },
    },
    plugins: [
      magicLink({
        disableSignUp: true,
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url }) => {
          await sendEmail({
            to: email,
            subject: "Your Social Planner sign-in link",
            ...actionEmail({ heading: "Sign in", body: "Tap the button to sign in. The link works once and expires in 15 minutes.", cta: "Sign in", url, footnote: "Didn't ask for this? You can ignore this email." }),
          });
        },
      }),
      // must stay last: applies Set-Cookie from server actions
      ...(opts.nextjs === false ? [] : [nextCookies()]),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;
/** Lazily created so `next build` doesn't need database credentials. */
export function getAuth(): Auth {
  return (cached ??= createAuth(getDb()));
}
