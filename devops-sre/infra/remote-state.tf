# The other planks' outputs, read from their state in the shared bucket.
# This is how the ops plank knows what to watch without hardcoding IDs.

data "terraform_remote_state" "mwa" {
  backend = "s3"
  config = {
    bucket = var.state_bucket
    key    = "modern-web-app.tfstate"
    region = "us-east-1"
  }
}

data "terraform_remote_state" "gai" {
  backend = "s3"
  config = {
    bucket = var.state_bucket
    key    = "genai-assistant.tfstate"
    region = "us-east-1"
  }
}

data "terraform_remote_state" "hub" {
  backend = "s3"
  config = {
    bucket = var.state_bucket
    key    = "demo-hub.tfstate"
    region = "us-east-1"
  }
}

locals {
  # HTTP API IDs, parsed from the endpoint URLs (https://<id>.execute-api...)
  mwa_api_id = regex("https://([a-z0-9]+)\\.", data.terraform_remote_state.mwa.outputs.api_endpoint)[0]
  gai_api_id = regex("https://([a-z0-9]+)\\.", data.terraform_remote_state.gai.outputs.api_endpoint)[0]

  mwa_dist_id = data.terraform_remote_state.mwa.outputs.distribution_id
  gai_dist_id = data.terraform_remote_state.gai.outputs.distribution_id
  hub_dist_id = data.terraform_remote_state.hub.outputs.distribution_id

  mwa_table = data.terraform_remote_state.mwa.outputs.table_name
  gai_table = data.terraform_remote_state.gai.outputs.table_name

  # The URLs the canary heartbeats.
  monitored_urls = [
    "https://demos.planetek.org",
    "https://permits.demos.planetek.org",
    "https://assistant.demos.planetek.org",
  ]
}
