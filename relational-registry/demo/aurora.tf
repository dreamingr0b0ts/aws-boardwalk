# Aurora Serverless v2 PostgreSQL that can genuinely reach zero: min capacity
# 0 ACU with a 5-minute auto-pause. All access rides the RDS Data API (HTTPS +
# IAM), so nothing needs network reachability to the cluster — no NAT, no
# VPC-attached Lambdas, and a security group with no ingress at all.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_db_subnet_group" "registry" {
  name       = "${local.prefix}-registry"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_security_group" "cluster" {
  name        = "${local.prefix}-cluster-sg"
  description = "Aurora registry cluster - no ingress by design; all access is via the RDS Data API (HTTPS + IAM), never a database socket"
  vpc_id      = data.aws_vpc.default.id
  # No ingress and no egress rules: the Data API terminates at the RDS
  # service, so the cluster never accepts or initiates network connections.
}

resource "aws_rds_cluster" "registry" {
  cluster_identifier = "${local.prefix}-registry"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" # Serverless v2 uses provisioned mode + a db.serverless instance
  engine_version     = "17.7"
  database_name      = "alpenglow"

  # Master credential is created and stored by RDS itself in Secrets Manager —
  # never in state, never in the repo — and is destroyed with the cluster.
  master_username             = "registry_admin"
  manage_master_user_password = true

  # The whole point: scale-to-zero. 0 ACU floor + auto-pause after 5 idle
  # minutes means a deployed-but-quiet cluster bills no compute at all.
  serverlessv2_scaling_configuration {
    min_capacity             = 0
    max_capacity             = 1
    seconds_until_auto_pause = 300
  }

  enable_http_endpoint                = true # RDS Data API
  storage_encrypted                   = true
  iam_database_authentication_enabled = true
  backup_retention_period             = 7
  copy_tags_to_snapshot               = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]

  db_subnet_group_name   = aws_db_subnet_group.registry.name
  vpc_security_group_ids = [aws_security_group.cluster.id]

  # Teardown root: destroy must be one clean command.
  deletion_protection = false
  skip_final_snapshot = true
  apply_immediately   = true

  depends_on = [aws_cloudwatch_log_group.postgresql]
}

resource "aws_rds_cluster_instance" "registry" {
  identifier           = "${local.prefix}-registry-1"
  cluster_identifier   = aws_rds_cluster.registry.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.registry.engine
  engine_version       = aws_rds_cluster.registry.engine_version
  db_subnet_group_name = aws_db_subnet_group.registry.name
  publicly_accessible  = false

  auto_minor_version_upgrade = true

  performance_insights_enabled = true # free 7-day tier

  apply_immediately = true
}

# Declare the export log group ourselves so retention is bounded (RDS would
# otherwise create it with never-expire).
resource "aws_cloudwatch_log_group" "postgresql" {
  name              = "/aws/rds/cluster/${local.prefix}-registry/postgresql"
  retention_in_days = 14
}

# ---- least-privilege application credential --------------------------------
# The public query API never touches the master credential: the seed Lambda
# creates a Postgres role `app_user` (SELECT on registry, INSERT/UPDATE only
# where the rollback exhibits need it) with this password.

resource "random_password" "app_user" {
  length           = 28
  special          = true
  override_special = "!#%^*()-_=+" # no quotes/backslashes — interpolated into ALTER ROLE
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.prefix}-app-credentials"
  description             = "Least-privilege Postgres login the public query API uses over the RDS Data API"
  recovery_window_in_days = 0 # teardown must free the name for the next demo window
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    username = "app_user"
    password = random_password.app_user.result
  })
}

# ---- runtime discovery for the always-on query Lambda ----------------------
# SecureString (default aws/ssm key) even though these are just ARNs — it
# keeps CKV2_AWS_34 meaningful for parameters that ARE secret elsewhere in
# the boardwalk, at zero cost.

resource "aws_ssm_parameter" "cluster_arn" {
  name  = "${local.ssm_prefix}/cluster-arn"
  type  = "SecureString"
  value = aws_rds_cluster.registry.arn
}

resource "aws_ssm_parameter" "app_secret_arn" {
  name  = "${local.ssm_prefix}/app-secret-arn"
  type  = "SecureString"
  value = aws_secretsmanager_secret.app.arn
}

resource "aws_ssm_parameter" "database" {
  name  = "${local.ssm_prefix}/database"
  type  = "SecureString"
  value = aws_rds_cluster.registry.database_name
}
