# Chapter 2 — Backend Security Implementation Report

**Branch:** `chapter-2/final-report`
**Base:** `main` @ `47bbc4bd4b113c97491518bc1d5876ae838f1445`
**Status:** Implemented and tested locally. **Not merged. No migration applied. No production change.**

This report documents the actual code changes made for Chapter 2, the exact commands run,
and the honest results — including what remains blocked by missing credentials.

---

## 0. What changed, in one table

| Area | Before (main) | After (this branch) |
|---|---|---|
| Sign-in | Demo OTP `482910`, no password | Supabase Auth `signInWithPassword` |
| Sign-up | Name + mobile only | `signUp` with email + password; server assigns role |
| Session | Fake flag in `localStorage` | Supabase persisted session + `onAuthStateChange` |
| Role | Client-chosen (`adminCheck` checkbox, `state.role`) | `profiles.role` from the database, read-only to clients |
| Admin authz | Hardcoded PIN `EXP-ADMIN-2026` | `public.is_retailer_admin()` + RLS `packages_admin_write` |
| Package catalogue | Hardcoded `PACKAGES` array | `public.packages` table, filtered by RLS |
| Database | No migration | `supabase/migrations/20261017120000_auth_profiles_rls.sql` |
| Tests | 105 (Chapter 1) | 195 automated + a live API probe |

Chapter 1 hardening (untrusted-state sanitisation, HTML escaping, PWA cache versioning,
CDN SRI pinning) is **preserved**, not replaced.

---

## 1. Files changed

| File | Change |
|---|---|
| `index.html` | Real Supabase Auth wired to the existing UI; demo auth removed; Chapter 1 hardening kept |
| `supabase/migrations/20261017120000_auth_profiles_rls.sql` | New. Tables, triggers, helpers, RLS, least-privilege grants, admin preservation, post-conditions |
| `tests/auth-rls.test.mjs` | New. Runs the migration against real Postgres (PGlite/WASM) and asserts RLS behaviour |
| `tests/live-api-authz.test.mjs` | New. Live probe of the real project with the publishable key only |
| `tests/security-static.test.mjs` | Extended with Chapter 2 static assertions (demo removal, real auth, DB roles) |
| `tests/ui-regression.test.mjs` | Rewritten for the real auth UI; still exercises every existing screen |
| `tests/xss.test.mjs` | Harness hardened (fresh browser per target) to survive the larger run |
| `package.json` / `package-lock.json` | Added `test:rls`, `test:api-authz`, `@electric-sql/pglite` |

No file was deleted. No existing package was removed or upgraded.

---

## 2. Authentication and roles (requirements 1–3)

### 2.1 Real Supabase Auth

`index.html` now creates the client once, with persistent sessions:

```js
const supabaseClient = (window.supabase && typeof window.supabase.createClient === "function")
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;
```

The `window.supabase` guard keeps the offline PWA app shell usable when the CDN library is
unreachable — the app degrades to a signed-out shell instead of throwing on boot. This is why
the Chapter 1 offline tests still pass.

- **Sign up:** `auth.signUp({ email, password, options: { data: { full_name, msisdn } } })`.
  The client sends *profile details only*. It never sends a role.
- **Sign in:** `auth.signInWithPassword({ email, password })`.
- **Sign out:** `auth.signOut()`, then local identity state is cleared.
- **Boot:** `auth.getSession()` restores the session; `onAuthStateChange` keeps it fresh.

### 2.2 Roles come from the database only

The role is read from `profiles`, and only `profiles`:

```js
async function loadProfile() {
  const user = state.session && state.session.user;
  if (!user) { state.profile = null; return; }
  const { data, error } = await supabaseClient
    .from("profiles").select("id, role, full_name, msisdn, is_active")
    .eq("id", user.id).maybeSingle();
  if (error || !data) {
    // Never trust client-side role data: fall back to the least privilege.
    state.profile = { id: user.id, role: "CUSTOMER" /* ... */ };
    return;
  }
  state.profile = data;
}
```

If the profile row cannot be read, the client assumes `CUSTOMER`. It never *grants* a role.
`isAdmin()` is `state.profile.role === "RETAILER_ADMIN"`. User metadata is never read for a role.

### 2.3 Demo authentication removed (requirement 3)

Removed from `index.html`: the OTP value `482910`, `requestOtp()`/`verifyOtp()`, the admin PIN
`EXP-ADMIN-2026`, the `adminCheck` checkbox, the `TEST AUTHENTICATION MODE` banner, and any
client-side `state.role` assignment. Identity is no longer restored from `localStorage`; the old
`expresso_app_state` key is purged on boot.

Verified by `tests/security-static.test.mjs` and `tests/ui-regression.test.mjs`.

---

## 3. Database and Row Level Security (requirement 4)

The migration is **idempotent** and **additive**. It creates or extends tables, re-creates
policies and grants, and never drops a table, truncates, or deletes rows.

### 3.1 Policies installed

| Policy | Table | Command | Applies to | Rule |
|---|---|---|---|---|
| `profiles_select_own` | `profiles` | SELECT | authenticated | `id = auth.uid() or is_retailer_admin()` |
| `profiles_update_own` | `profiles` | UPDATE | authenticated | `id = auth.uid()` |
| `packages_select_authenticated` | `packages` | SELECT | authenticated | `is_enabled or is_retailer_admin()` |
| `packages_admin_write` | `packages` | ALL | authenticated | `is_retailer_admin()` |

`anon` holds **no** privilege on either table. The migration first drops *every* existing policy
on both tables, because RLS policies are OR-ed — one surviving `using (true)` policy would
silently defeat all of the above.

### 3.2 Least privilege

`revoke all` runs before any grant, so a pre-existing table-level `UPDATE` cannot linger. The
client is then granted column-scoped update on `full_name`, `msisdn` and `phone` only. `role`,
`is_active` and `email` are never client-writable.

### 3.3 Two independent barriers against self-promotion

1. **Column grants** omit `role`/`is_active`/`email`, so a client cannot write them.
2. **`profiles_guard_role` trigger** raises an exception if a client role
   (`anon`/`authenticated`/`authenticator`) changes any of those three columns — even if a future
   migration or dashboard action reintroduces a table-level `UPDATE` grant.

Both are tested: `tests/auth-rls.test.mjs` grants a table-level `UPDATE` mid-test and confirms the
guard still rejects the write, while the privileged role is not blocked.

### 3.4 Privileged helpers

`is_retailer_admin()`, `handle_new_user()` and `set_updated_at()` are `SECURITY DEFINER` with
`search_path = ''` pinned. The migration asserts none of them is owned by a client role, and
`EXECUTE` is revoked from `PUBLIC`.

### 3.5 `public.packages` — approved decision (Q-8)

Per the approved decision, `public.packages` is readable by **authenticated users only**;
anonymous access is prohibited. The migration implements exactly that:
`grant select on public.packages to authenticated` (no `anon` grant), and
`packages_select_authenticated` requires an authenticated session.

**This is a live finding until the migration is applied — see section 5.2.**

---

## 4. Preserving the retailer-admin account (requirement 5)

The migration does not hard-code a promotion. It verifies the authorized account before
promoting it:

- the account must exist in `auth.users`, and
- it must be the sole author of the existing bundle catalogue (`packages.created_by`).

If either check fails, the migration **aborts** rather than promote a wrong or non-existent
identity. The expected id can be overridden with
`select set_config('expresso.retailer_admin_id', '<uuid>', true);`.
The default is the authorized account `bdd8f73c-fd23-4d76-9d23-7f4942300c36`.

Existing packages and profiles are preserved. The test asserts row counts before and after.

---

## 5. Tests actually run (requirements 7–8)

```
npm test
```

| Suite | Result |
|---|---|
| `syntax.test.mjs` | 5 passed, 0 failed |
| `security-static.test.mjs` | 70 passed, 0 failed |
| `xss.test.mjs` | 17 passed, 0 failed |
| `pwa-sw.test.mjs` | 16 passed, 0 failed |
| `ui-regression.test.mjs` | 28 passed, 0 failed |
| `auth-rls.test.mjs` | 59 passed, 0 failed |
| **Total (`npm test`)** | **195 passed, 0 failed** |

The RLS suite runs the migration against a **real Postgres engine** (PGlite, a WASM build of
Postgres) starting from a deliberately dirty legacy state — permissive `using (true)` policies and
broad table-level grants — and proves the migration cleans it up.

Additional live probe (`npm run test:api-authz`, uses only the public publishable key):

| Check | Result |
|---|---|
| anon read `profiles` blocked | pass |
| anon INSERT `packages` denied | pass |
| anon UPDATE `packages` denied | pass |
| anon DELETE `packages` denied | pass |
| anon UPDATE `profiles` (self-promotion) denied | pass |
| publishable key cannot call the auth admin API | pass |
| **anon read `packages` blocked** | **FAIL — HTTP 200, 5 rows (C-1)** |

### 5.1 Fixed during this work

- The XSS suite crashed the Chromium renderer partway through the enlarged run. The harness now
  launches a fresh browser per target. This is a test-harness fix, not an app change; the XSS
  assertions themselves were unchanged and pass 17/17.
- The Chapter 1 UI test used demo selectors that Chapter 2 removes. It was rewritten for the real
  auth UI and still exercises every existing screen and feature.

### 5.2 Honest result on T-17 / C-1

`tests/live-api-authz.test.mjs` **fails 2 of 9 checks**, on purpose. The real project still
returns HTTP 200 with 5 rows for an anonymous `select` on `public.packages`. The migration that
fixes this is committed on this branch but **has not been applied**, because I have no database
credential (see section 7). The failure is the correct, honest signal. It will pass once the
migration is applied.

---

## 6. Security properties of this change

- The publishable (`sb_publishable_...`) key is the only key in the client. It is designed to be
  public. No `service_role` key, no `sb_secret_` key, no database URL is present in any file.
- Every authorization decision is made by Postgres RLS and the `profiles` table — never by the
  client.
- No secret was printed, logged, or committed.
- No destructive operation was run against production. The migration contains no
  `DROP TABLE`, `TRUNCATE`, or `DELETE`.

---

## 7. Blocked work, and exactly what is needed

| Item | Blocker | What unblocks it |
|---|---|---|
| Apply the migration to the live project | No `SUPABASE_DB_URL` and no service-role key | Owner runs the SQL, or grants a DB connection / service-role key |
| Close C-1 (T-17) | Same | Apply the migration, then re-run `npm run test:api-authz` |
| Phone OTP end-to-end | `phone_provider_disabled`; no OTP endpoint | Enable the phone provider + provider credentials; build the OTP endpoint (Chapter 3) |
| Post-apply catalogue audit (T-31) | No DB credential | An owner-level connection after the migration is applied |

I did **not** apply the migration, enable providers, or change Supabase configuration: those
actions need credentials and permission I do not have, and the task explicitly forbids
production changes and migration execution.

---

## 8. How to review

```bash
git checkout chapter-2/final-report
npm install
npm test                 # 195 passed, 0 failed
npm run test:api-authz   # 7 passed, 2 failed (C-1, until the migration is applied)
```

The diff is confined to `index.html`, the test suites, `package.json`/`package-lock.json`, and the
new `supabase/` directory. Chapter 1 behaviour and the design documents
(`docs/chapter-2-audit.md`, `docs/chapter-2-final-report.md`) are unchanged by this work.
