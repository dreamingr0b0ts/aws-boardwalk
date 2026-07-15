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
    allow_admin_create_user_only = false # public self-signup is part of the demo
  }

  schema {
    name                = "name"
    attribute_data_type = "String"
    mutable             = true
    required            = false
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  lambda_config {
    post_confirmation = aws_lambda_function.postconfirm.arn
  }

  deletion_protection = "INACTIVE" # demo environment; make destroy must work
}

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.users.id
  description  = "Permit office staff — review queue, decisions, catalog management"
}

resource "aws_cognito_user_group" "citizen" {
  name         = "citizen"
  user_pool_id = aws_cognito_user_pool.users.id
  description  = "Residents — submit and track their own applications"
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${local.prefix}-spa"
  user_pool_id = aws_cognito_user_pool.users.id

  generate_secret = false # public SPA client; SRP proves the password without sending it

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
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

# Adds every confirmed self-signup to the citizen group so RBAC has an
# explicit group claim for all users, never an implicit default.
resource "aws_lambda_permission" "cognito_postconfirm" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.postconfirm.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.users.arn
}

resource "aws_iam_role_policy" "postconfirm_cognito" {
  name = "add-user-to-citizen-group"
  role = aws_iam_role.postconfirm.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["cognito-idp:AdminAddUserToGroup"]
      Resource = aws_cognito_user_pool.users.arn
    }]
  })
}
