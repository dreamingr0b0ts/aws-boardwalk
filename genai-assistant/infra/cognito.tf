# The Cognito gate is the plank's first cost guardrail: every AI route requires
# a valid JWT, and — unlike plank 1 — there is NO self-signup and the demo
# credential is never printed on the site. Admin-created users only.

resource "aws_cognito_user_pool" "users" {
  name = "${local.prefix}-users"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = true # no public sign-up — the token gate must hold
  }

  deletion_protection = "INACTIVE" # demo environment; make destroy must work
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${local.prefix}-spa"
  user_pool_id = aws_cognito_user_pool.users.id

  generate_secret = false # public SPA client

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",       # zero-build static frontend authenticates with a plain InitiateAuth call over TLS
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_ADMIN_USER_PASSWORD_AUTH", # server-side only: lets the verify script mint tokens via admin-initiate-auth
  ]

  prevent_user_existence_errors = "ENABLED"

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user" "demo" {
  user_pool_id = aws_cognito_user_pool.users.id
  username     = var.demo_email
  password     = var.demo_password # permanent; user lands in CONFIRMED state

  attributes = {
    email          = var.demo_email
    email_verified = "true"
  }
}
