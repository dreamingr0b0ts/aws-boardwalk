# The responsible-AI exhibit: one Bedrock Guardrail the bench can switch on
# per run. Sensitive identifiers (emails, phone numbers, SSNs) are ANONYMIZED
# rather than blocked so the masking is visible in the answer text, and one
# denied topic (legal advice) shows a hard block. Guardrails bill per text
# unit only when applied; every guarded run is still inside the daily caps.

resource "aws_bedrock_guardrail" "workbench" {
  name                      = "${local.prefix}-workbench-guardrail"
  description               = "PII masking + legal-advice topic block for the Model Workbench comparison bench"
  blocked_input_messaging   = "The guardrail blocked this request: it matched a denied topic (this bench cannot give legal advice)."
  blocked_outputs_messaging = "The guardrail blocked this answer: it matched a denied topic (this bench cannot give legal advice)."

  content_policy_config {
    filters_config {
      type            = "HATE"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "INSULTS"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "SEXUAL"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "VIOLENCE"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "MISCONDUCT"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    # PROMPT_ATTACK only screens input; output_strength must be NONE
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = "HIGH"
      output_strength = "NONE"
    }
  }

  sensitive_information_policy_config {
    pii_entities_config {
      type   = "EMAIL"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "PHONE"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "US_SOCIAL_SECURITY_NUMBER"
      action = "ANONYMIZE"
    }
  }

  topic_policy_config {
    topics_config {
      name       = "legal-advice"
      type       = "DENY"
      definition = "Requests for legal advice, legal strategy, or opinions on whether to sue, appeal, or pursue legal action against a person, business, or government."
      examples = [
        "Should I sue my contractor for the delay?",
        "Can I take the city to court over this permit denial?",
      ]
    }
  }
}

# Converse needs a numbered version; DRAFT is mutable and not for runtime use.
resource "aws_bedrock_guardrail_version" "workbench" {
  guardrail_arn = aws_bedrock_guardrail.workbench.guardrail_arn
  description   = "v1 - PII anonymize + legal-advice deny"
}
