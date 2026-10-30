# Northwood College website

## Run locally

Install dependencies with `npm install`, then start the app with `npm start`.
Without Turso environment variables, the app uses `data/college.db` and local
uploads. The initial local demo accounts are `admin@northwoodcollege.edu` /
`admin123`, `student@northwoodcollege.edu` / `student123`, and
`faculty@northwoodcollege.edu` / `faculty123`.

## Deploy to Vercel

Keep the Vercel project's **Root Directory** at the repository root. Vercel
detects the Express app in `app.js`; `vercel.json` ensures the EJS templates
are bundled with the function. Static files in `public/` are served by Vercel's
CDN.

1. Create a Turso database and set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
   in the Vercel project's Production and Preview environments.
2. Set `SESSION_SECRET` to a long, random value. For example, run
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   and add its output as the environment variable.
3. Before the first request to the deployed app, set `INITIAL_ADMIN_EMAIL` and
   `INITIAL_ADMIN_PASSWORD` to the production administrator's credentials.
   The first request initializes the remote schema and seeds the starter
   content. Production does not create the predictable local demo accounts.
4. Create a **private** Vercel Blob store and connect it to this Vercel project.
   Vercel supplies the store credentials. This is required for application
   document uploads; documents are only downloadable by an authenticated
   administrator.
5. Redeploy after setting environment variables and connecting storage.

The local SQLite database is ignored by Git and is not copied to Vercel.
Deploying therefore starts with a new remote database; export/import any local
records separately if they need to be retained. Vercel uploads are limited to
4 MiB to stay within the function request-size limit.
