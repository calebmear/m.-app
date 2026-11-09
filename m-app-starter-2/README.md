# m. app

A personal monthly budget: a compact paycheck schedule, checking bills, and a credit card ledger. This is a separate project for **calebmear/m.-app**. It contains no QPI code, real budget records, account credentials, or bank connections.

[Open the repository in StackBlitz](https://stackblitz.com/github/calebmear/m.-app)

## Start in StackBlitz

1. Upload the **contents** of this folder to the root of [calebmear/m.-app](https://github.com/calebmear/m.-app/upload/main), then commit. `package.json` and `index.html` should be at the repository root.
2. Open the StackBlitz link above. Alternatively, open a new [Vite JavaScript starter](https://vite.new/vanilla) and drag this folder's contents into it.
3. StackBlitz installs dependencies and runs `npm run dev`. If it does not start, run:

   ```sh
   npm install
   npm run dev
   ```

4. The app works immediately in **device-only mode**, with a blank budget. Data in this mode stays in that browser's local storage. StackBlitz preview storage and a Netlify site are different browser origins.
5. Commit the generated `package-lock.json` after the first install.

StackBlitz can require authentication/authorization to edit or commit to your GitHub repository. The app's Supabase sign-in is a separate login.

## Your first month

1. Select the month at the top.
2. Enter beginning checking directly in the schedule. This is the actual starting checking balance, entered manually; it is not automatically copied from a projected rollover.
3. Edit paycheck amounts and days directly in the schedule. Check **Received** after a deposit clears. Add additional checks below the schedule.
4. Add bills with amounts and expected debit days. Use **End of month** where appropriate.
5. Under **Month options**, choose **Use bills & paychecks as future defaults**. New months copy these defaults; existing saved months keep their own records. Ordinary monthly edits never update the defaults.
6. Enter card activity. Leave the date blank for pending; type `MM/DD/YY` to post. Posted entries sort newest first, followed by pending entries. Refunds use negative amounts.
7. Enter the **previous statement payment** separately when it is due in this month. Mark it cleared when the bank payment processes. New charges entered in the current ledger are reserved separately.
8. Mark bills paid and update actual amounts as they clear. Every edit saves on Enter or when leaving the field.

The forecast counts every scheduled bill once. Marking a bill paid changes recorded checking, not the forecast. All entered card charges count toward projected rollover, including uncategorized and pending charges. Adding a posted date never deducts the charge again.

**Recorded checking** includes cleared items. **Ending rollover** includes all scheduled income/expenses and all entered new card activity. **Lowest rolling balance** checks the chronological schedule for a shortfall. The forecast includes spending entered so far; it does not estimate future discretionary spending.

## Connect the new Supabase project

Use a dedicated Supabase project for m. app. Do not run this setup against your QPI project.

1. In that Supabase project's SQL Editor, run [`supabase/migrations/202611030001_m_app.sql`](supabase/migrations/202611030001_m_app.sql) once.
2. In **Authentication → Users**, create your account with an email and password. Disable public new-user signups in the project's authentication settings if this app is only for you. The app provides sign-in, not a public sign-up form.
3. Copy the project URL and **publishable key** from the project's Connect/API settings.
4. In StackBlitz, create `.env.local` using `.env.example`:

   ```dotenv
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
   ```

   Use the browser-safe publishable key. Never place a service-role key, secret key, database password, or access token in a `VITE_` variable or the repository. Legacy browser-safe `anon` keys also work if that is what your project provides.

5. Restart `npm run dev`, then sign in with the account you created.

Cloud mode is the source of truth after configuration. Device-only data is not automatically uploaded or mixed into a signed-in account; use month exports for a manual record before switching modes.

### Database design

- `m_app_months`: one JSON budget document per user and month, with a revision number. A save updates the entire month atomically, so its linked schedule, bills, and charges cannot partially save.
- `m_app_preferences`: recurring defaults, separate from monthly records.
- `m_app_month_history`: an immutable snapshot for every successful cloud save, retained for recovery. History is currently inspected in Supabase; an in-app history viewer is a future enhancement.

All three tables have row-level security. Signed-in users can read only their own rows. Client writes use authenticated SQL functions that check ownership and the expected revision; stale saves return a conflict rather than overwriting a change from another device. Direct client table writes are not granted.

Cloud saves require a network connection. A failed save remains visible as **not saved**, and month switching is blocked until it is retried or you explicitly reload the saved version. This starter does not offer offline cloud sync or automatic bank imports.

Closing a month prevents editing. Reopen it before making corrections. The database also enforces reopening before changing a closed document.

## Deploy through Netlify

1. Commit the app to [calebmear/m.-app](https://github.com/calebmear/m.-app).
2. In Netlify choose **Add new project → Import an existing project → GitHub**, and select `m.-app`.
3. The included `netlify.toml` specifies:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Node: `22`
4. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Netlify's environment variable settings **before building**.
5. Deploy and sign in. Save changes in StackBlitz back to GitHub to trigger subsequent Netlify builds.

Use the Netlify URL on your phone and iPad. The layout stacks on phones, adapts to iPad widths, uses larger touch controls, and preserves typed `MM/DD/YY` entry. The web manifest supports a home-screen shortcut. The app still needs a network connection for cloud saves.

## Validation

```sh
npm test
npm run build
```

The included tests cover exact cents, valid/invalid dates, pending/posted transitions, refunds, bill/payment double counting, independent months, February/leap-year dates, chronological shortfalls, and revision conflicts.

During preparation, the same 15 budgeting/repository checks passed in the available JavaScript runtime, and the modules passed syntax checks. A local dependency install, Vite production build, live Supabase migration/auth test, and browser/device QA could not be run in the preparation environment. The GitHub workflow runs `npm test` and `npm run build` after upload. Verify login and saving with two separate accounts before relying on a live deployment.

## Files

```text
src/budget.js       Money, dates, schedule, forecasts, month creation
src/main.js         Responsive app and sign-in interface
src/repository.js   Device storage and Supabase reads/writes
src/supabase.js     Environment-based Supabase client
src/styles.css      Phone, iPad, desktop, and dark appearance
supabase/migrations Database tables, access rules, save functions
tests/              Budget calculations and storage conflict tests
netlify.toml        Deployment settings
```

Official setup references: [StackBlitz imports](https://developer.stackblitz.com/guides/user-guide/importing-projects), [Supabase client setup](https://supabase.com/docs/guides/getting-started/quickstarts/reactjs), [Vite on Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/).
