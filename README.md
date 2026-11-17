# SideQuest

A small-jobs board. Someone posts a task (water my plants this weekend, paint a nursery mural, assemble a stroller), someone nearby takes it. **Both people put down the same deposit.** It is held while the task is pending and returned when the job is done. If someone backs out or does not show up, the team can award their deposit to the person who was let down.

The app name lives in `appName` in `js/config.js`.

## How the money works

| Moment | What happens |
| --- | --- |
| Poster publishes a task | Poster pays the deposit (Stripe Checkout). The task goes on the board. |
| Someone takes it | They get a 45 minute hold, pay the same deposit, and the exact address unlocks for them. |
| Job finished | Taker marks it done with a photo. Poster confirms (or it confirms itself after 48 hours). Both deposits are refunded. |
| Poster cancels before anyone takes it | Deposit refunded in full. |
| Someone backs out or reports a problem | Both deposits freeze. Each person adds evidence. The team rules: refund both, or award the guilty person's deposit to the other (paid out by bank transfer, recorded in the Team area). |

The **reward itself is not held**. The poster pays it directly to the taker. SideQuest only holds deposits. If you want the reward held too, that is a change to talk through first.

Money notes you should know before real customers use this:

* **FPX refunds are slow.** Stripe says an FPX refund can take up to 14 days to reach the bank, sometimes longer, and Stripe only allows refunds within 180 days of the payment. The interface says so. If a refund fails, it shows under "Needs attention" in the Team area.
* **Stripe in Malaysia needs a registered business.** Check Stripe's current requirements for your account, and whether holding customers' money for days is allowed under your business setup and local rules (talk to Stripe or a lawyer). This README is not legal advice.
* **ID photos are personal data.** Verification photos are visible only to admins and are deleted when the admin decides. Look at Malaysia's PDPA before you go live, and publish a privacy notice.

## What is in the box

```
index.html              page shell
css/styles.css          all styles
js/config.js            the only file you edit to connect your project
js/views/               browse, post, task, my tasks, profile, admin, sign in, payment return
supabase/schema.sql     tables, security rules, deposit/dispute logic (run once)
supabase/functions/     Stripe checkout, webhook, refunds, completion, rulings, sweeper
```

The website is plain HTML, CSS and JavaScript, so GitHub Pages hosts it for free. All data, sign-in, photos and chat live in **Supabase**. Payments run through **Stripe**, from small server functions that hold the secret keys. No secret key is ever in the website code.

## Set up (about an hour)

### 1. Supabase

1. Create a project at supabase.com.
2. SQL Editor: paste all of `supabase/schema.sql` and run it. It is safe to run again later.
3. Authentication, URL configuration: set **Site URL** to your GitHub Pages address (step 4), and add it under Redirect URLs.
4. Sign up on your site once, then make yourself the admin in the SQL Editor:
   ```sql
   update profiles set role = 'admin'
   where id = (select id from auth.users where email = 'you@example.com');
   ```
5. Project Settings, API: copy the **Project URL** and the **anon public key** into `js/config.js`. (The anon key is meant to be public.)

### 2. Stripe

1. Create a Stripe account, set the country to Malaysia, and switch on **FPX** in payment methods. Test mode first.
2. Copy the secret key (starts `sk_test_`).
3. Developers, Webhooks: add an endpoint `https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook` listening to `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `refund.failed`. Copy its signing secret.

### 3. Deploy the functions

With the [Supabase CLI](https://supabase.com/docs/guides/cli) installed:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF

supabase secrets set STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_WEBHOOK_SECRET=whsec_xxx \
  SITE_URL=https://YOUR-USERNAME.github.io/YOUR-REPO \
  CRON_SECRET=make-up-a-long-random-string
# only while testing on your own computer:
# supabase secrets set EXTRA_ORIGINS=http://localhost:8080

supabase functions deploy create-deposit-checkout complete-task cancel-task admin-resolve-dispute
supabase functions deploy stripe-webhook sweep-expired --no-verify-jwt
```

### 4. Run the sweeper every 5 minutes

It expires unpaid holds, auto-confirms jobs the poster never answered, retries failed refunds, and cancels tasks nobody took by their deadline.
In Supabase, Database, Extensions: switch on `pg_cron` and `pg_net`. Then in the SQL Editor:

```sql
select cron.schedule('sidequest-sweep', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/sweep-expired',
    headers := jsonb_build_object('x-cron-secret', 'THE-SAME-CRON_SECRET', 'Content-Type', 'application/json'),
    body := '{}'::jsonb);
$$);
```

### 5. GitHub Pages

1. Create a GitHub repository and push this folder to it.
2. Settings, Pages: deploy from branch `main`, folder `/ (root)`.
3. Your site is at `https://YOUR-USERNAME.github.io/YOUR-REPO`. Put that in the Supabase Site URL and the `SITE_URL` secret.

### 6. Editing in Antigravity

Open the folder, edit, and test locally:

```bash
python3 -m http.server 8080      # then open http://localhost:8080
```

Add `http://localhost:8080` to Supabase Redirect URLs and set the `EXTRA_ORIGINS` secret while you do. Push to GitHub and Pages redeploys.

### Going live

Do a full test-mode run with two accounts first (post, take, pay with Stripe test card `4242 4242 4242 4242`, finish, confirm, then a back-out with evidence and a ruling). Only then switch Stripe to live keys and re-set the two Stripe secrets.

## Known limits

* Rulings are manual: a person on your team reads the evidence and decides. Payouts of forfeited deposits are bank transfers you make by hand, then record in the Team area.
* There are no email or push notifications yet, so people see changes when they open the site (the task page does update live while open).
* The reward is outside the system (see above).
