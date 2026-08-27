# KWD Rate — Price Trust Layer v1

The Trust Layer prevents a suspicious or stale quote from winning the comparison solely because its numeric rate is attractive.

## Scoring
- Freshness: 25%
- Source reliability: 20%
- Market consensus: 25%
- CBK reference deviation: 20%
- Data completeness: 10%

## Hard blocks
- Expired quote
- Older than 180 minutes
- Invalid/non-positive rate
- Market outlier > 5% when at least 3 companies are available
- Source confidence below 40

Eligible quotes require a Trust Score >= 65 and no hard block.

## API
`GET /api/compare?amount=1000&from=KWD&to=USD&method=CASH`

The response now includes `trust_score`, `trust_status`, `trust_reasons`, `trust_flags`, `eligible`, and component scores.

`GET /api/trust/USD?method=CASH&amount=1000`

Returns compact trust diagnostics for the latest quote per company.
