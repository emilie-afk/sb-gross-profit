# Make scenarios — archived

**Retired architecture. Production automation uses the Windows collector and Cloudflare Worker orchestration.**

Nothing in this repository is configured through Make, and no Make scenario, connection, data store or webhook is part of any deployment step. The Revision 8 scenario instructions that used to be here are kept only in Git history.

Current design:

- Windows collector: `automation/collector/README.md` (one scheduled task: ShipStation Shipping Cost Report, then the Shopify rolling export).
- Worker orchestration: `DEPLOYMENT.md` → "Weekly orchestration (C7)" and the C8 deployment package (`docs/c8-deployment-package.md`).
