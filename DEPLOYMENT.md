# Deployment overview

The gross-profit dashboard has four parts: the dashboard site, a worker that stores collected reports and computes weekly results, an independent verifier that rechecks each week before it is used, and a scheduled collector that exports and sanitizes the source reports.

Supplier costs, discount tiers, vendor names and the scenario starting values are not in this repository. Every part loads them from one private rules document, and none will calculate without it. Tests use `tests/fixtures/private-rules.synthetic.json`, whose values are invented.

Configuration, credentials and operator procedures are kept privately by the team.

## Tests

```
npm test               # engine, adapters, contract and worker, with the invented rules
npm run test:browser   # dashboard in Chromium against a local worker (synthetic data)
```
