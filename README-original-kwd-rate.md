# KWD Rate Full-Stack v3

KWD Rate now includes a rate collector layer for public sources:
- Central Bank of Kuwait reference rates
- KBE Kuwait public rates
- BEC Kuwait public KWD-labelled pair(s) when explicitly exposed

The collector stores every observation in PostgreSQL, preserving history. It never treats the CBK reference rate as a competing exchange company; the API exposes it separately at `/api/reference/:code`.

## Run
```bash
docker compose up -d
npm install
npm start
```
Open `http://localhost:3000` and `http://localhost:3000/admin`.

## Manual sync
```bash
npm run sync
```
Or, as admin:
```http
POST /api/admin/sync
x-admin-key: YOUR_ADMIN_KEY
```

## Automatic sync
Enabled by default every 30 minutes. Change `RATE_SYNC_MINUTES` or set `ENABLE_AUTO_SYNC=false`.

### Data policy
Source values are stored with their source and timestamp. Public pages can change structure or terms; before production use, obtain permission/API access where required and respect each provider's terms and robots/access rules. BEC itself states its public rates are indicative and can vary by branch, bank, or service.

## Maps & Branch Intelligence v1
- Leaflet + OpenStreetMap map on the public site.
- Browser geolocation for nearby branch discovery.
- `/api/branches?` search endpoint.
- `/api/branches/nearby?lat=&lng=&radius=` nearby endpoint.
- `/api/nearby-best` combines branch distance with current rate/trust data.
- Branch services, map label, and verification timestamp fields.
- Admin branch update endpoint.
- Migration: `db/005_branches_intelligence.sql`.

The map uses OpenStreetMap tiles. Production deployments should review tile usage policy and consider a hosted tile provider for high traffic.
