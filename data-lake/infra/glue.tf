# The Glue Data Catalog is the lake's schema layer: Athena plans every query
# against these definitions, never against the files themselves.
#
# Only the RAW table is declared here — its schema is a contract with the
# ingest script, so it belongs in IaC. The curated table is created by the
# ETL's CTAS statement (that's the point of the demo: the catalog entry, the
# Parquet layout, and the partitions all fall out of one SQL statement), so
# Terraform deliberately doesn't manage it.

resource "aws_glue_catalog_database" "lake" {
  name        = local.glue_db
  description = "Colorado business-registration data lake (aws-boardwalk plank 5)"
}

resource "aws_glue_catalog_table" "raw" {
  name          = local.raw_table
  database_name = aws_glue_catalog_database.lake.name
  table_type    = "EXTERNAL_TABLE"
  description   = "Raw zone: Business Entities in Colorado (data.colorado.gov 4ykn-tg5h), gzipped JSONL exactly as ingested. Column names preserved from the source — including its 'jurisdictonofformation' typo; the ETL fixes that downstream."

  parameters = {
    EXTERNAL       = "TRUE"
    classification = "json"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.lake.bucket}/${local.raw_prefix}/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      serialization_library = "org.openx.data.jsonserde.JsonSerDe"
      parameters = {
        "ignore.malformed.json" = "true"
      }
    }

    dynamic "columns" {
      for_each = [
        "entityid",
        "entityname",
        "principalcity",
        "principalstate",
        "principalzipcode",
        "entitystatus",
        "entitytype",
        "jurisdictonofformation", # (sic) — the source really spells it this way
        "agentorganizationname",
        "entityformdate",
      ]
      content {
        name = columns.value
        type = "string"
      }
    }
  }
}
