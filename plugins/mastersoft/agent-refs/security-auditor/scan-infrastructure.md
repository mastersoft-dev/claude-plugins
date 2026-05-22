# Infrastructure and Deployment

- **Docker**: Check for `root` user in containers, exposed ports, secrets in build args/layers, base image freshness
- **Kubernetes**: Review RBAC policies, network policies, pod security standards, secret management (no plaintext in manifests)
- **Cloud configs**: Flag overly permissive IAM roles, public S3/GCS buckets, open security groups
- **CI/CD**: Check for secrets in pipeline configs, verify deployment requires approval for production, review artifact signing
