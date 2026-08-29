# OpenEstate public website

This is the public marketing site for OpenEstate by The IT Guys.

## Local development

```bash
pnpm --filter @openestate/website dev
```

## Vercel

Create a Vercel project connected to the repository and set its Root Directory
to `apps/website`. Vercel will use the workspace lockfile and run the app's
`build` script. Add `theitguys.in` under Project Settings → Domains, then add
the DNS records Vercel shows for the domain.
