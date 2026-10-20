# The Birthwave — Registration Form

Standalone patient registration / check-in app (Next.js). The public marketing website lives in a separate project.

Routes: `/registration` (also `/`), `/thank-you`, `/staff`, plus the `/api/registrations`, `/api/queue/*` and `/api/staff/*` endpoints.

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests
npm run build && npm run test:e2e:checkin
```

Environment variables: see `docs/checkin.env.example`. Deployment notes: `docs/checkin-deployment.md`, `docs/registration-deployment.md`.
