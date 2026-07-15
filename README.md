# AWS Boardwalk

A portfolio of **working AWS environments** — each one a small, production-patterned system you can walk through live. Built by [Planetek](https://planetek.org) to demonstrate breadth across the domains buyers actually ask about: web, APIs, events, containers, data, AI, document intelligence, security, networking, and DevOps/SRE.

Design constraints for every plank:

- **Always-free-tier first.** Always-on environments idle at ~$0. Stacks with daily-billing services are deploy-demo-teardown only.
- **No banned services always-on:** NAT Gateway, ALB, RDS/OpenSearch instances, EKS, SageMaker endpoints, 24/7 Fargate.
- **IaC everywhere.** Terraform, remote state in S3, `env:<name>` tags on every resource.
- **One command up, one command down.** Every environment has `make deploy` / `make destroy`.

## The planks

| # | Environment | Mode | Status |
|---|-------------|------|--------|
| 1 | [Modern Web Application](./modern-web-app/) — three-tier serverless app with Cognito RBAC | always-on | ✅ **[live](https://permits.demos.planetek.org)** |
| 2 | API & Microservices | always-on | planned |
| 3 | Event-Driven & Messaging | always-on | planned |
| 4 | Containers (ECS Fargate, scale-to-zero) | on-demand | planned |
| 5 | Data Lake & Analytics | always-on | planned |
| 6 | [Generative AI (RAG)](./genai-assistant/) — cited RAG assistant with hard cost caps behind a Cognito gate | always-on | ✅ **[live](https://assistant.demos.planetek.org)** (access on request) |
| 7 | Intelligent Document Processing | always-on | planned |
| 8 | Security & Governance | deploy-demo-teardown | planned |
| 9 | Network Architecture | deploy-demo-teardown | planned |
| 10 | DevOps & SRE (builds all the others) | always-on | planned |

Plus the **[Demo Hub](./demo-hub/)** at **[demos.planetek.org](https://demos.planetek.org)** — one card per environment with live links.

## Repository layout

```
aws-boardwalk/
├── platform/          # Shared: Route53 zone (demos.planetek.org) + wildcard ACM cert
├── demo-hub/          # The boardwalk entrance — static hub at demos.planetek.org
├── modern-web-app/    # Plank 1 — Alpenglow Permits (see its README)
└── ...                # One folder per plank as they're built
```

`platform/` is applied once and shared by every plank; each plank keeps its own Terraform state and lifecycle.

## Bootstrap (once per AWS account)

```sh
make bootstrap    # creates the S3 Terraform state bucket
make platform     # creates the demos.planetek.org hosted zone + wildcard cert
make ns           # prints the 4 NS records to add at the domain registrar
```

---
*Everything here is demonstration infrastructure for fictional entities. It is not affiliated with any real government agency.*
