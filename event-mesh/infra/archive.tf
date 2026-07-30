# The event archive behind the "second section" exhibit: EventBridge records
# every event on the bus for 2 days (matching the 48h trace TTL), and a
# visitor-triggered StartReplay runs a past window through the mesh again.
#
# The pattern excludes replayed events on purpose — a replayed event arrives
# with a "replay-name" envelope field, and without this exists=false guard the
# archive would re-record every replay, so replaying the same window twice
# would compound duplicates exponentially. Verified live with
# TestEventPattern: plain events match, replayed events don't.
resource "aws_cloudwatch_event_archive" "mesh" {
  name             = "${local.prefix}-archive"
  description      = "Rolling 2-day record of service-request events for visitor-triggered replays"
  event_source_arn = aws_cloudwatch_event_bus.mesh.arn
  retention_days   = 2

  event_pattern = jsonencode({
    source        = [local.event_source]
    "replay-name" = [{ exists = false }]
  })
}
