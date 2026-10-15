# Alarms for the half of monitoring the application cannot do for itself: the
# instance under it. The API's own sweep (apps/api/src/monitoring/) emails about
# the application — a worker lane down, a stuck queue, failed jobs, low disk,
# AI spend caps — but it runs on this instance, so a dead host, a hung kernel or
# an instance pegged on CPU is reported from here instead, through SNS email.
# What each alarm means: docs/deployment.md, "Monitoring and alerts".
#
# Cost: three standard alarms on basic-monitoring metrics are inside
# CloudWatch's free ten alarms, and SNS email is free up to 1,000 a month.
#
# An email subscription does nothing until its address confirms it: AWS sends a
# "Subscription Confirmation" email on the first apply, and the link in it has
# to be clicked (within three days). Terraform cannot confirm it, and cannot
# delete a subscription that was never confirmed — destroying one only drops it
# from state.

variable "alert_email" {
  type        = string
  description = "Address CloudWatch alarms are emailed to through SNS. Empty creates the topic with no subscriber. AWS emails a confirmation link that must be clicked before anything is delivered."
  default     = ""
}

resource "aws_sns_topic" "alerts" {
  name = "book-maker-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# A failure on AWS's side of the instance (power, network, the physical host).
# `recover` moves the same instance — ID, Elastic IP, root volume — to healthy
# hardware. Two one-minute periods, so it never races the reboot alarm below,
# which waits three (AWS's own guidance). Status check metrics are published
# every minute at no charge, without detailed monitoring.
resource "aws_cloudwatch_metric_alarm" "system_status" {
  alarm_name          = "book-maker-status-check-system"
  alarm_description   = "AWS cannot reach the book-maker instance's host (hardware, power or network). Recovering it onto new hardware; see docs/deployment.md, Monitoring and alerts."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  dimensions          = { InstanceId = aws_instance.book_maker.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  # A gap in the metric is not a failure; acting on one would recover a healthy host.
  treat_missing_data = "missing"
  alarm_actions      = ["arn:aws:automate:${data.aws_region.current.name}:ec2:recover", aws_sns_topic.alerts.arn]
  ok_actions         = [aws_sns_topic.alerts.arn]
}

# The instance's own OS stopped answering: a kernel panic, exhausted memory with
# swap thrashing, a full root filesystem SSM cannot write to. A reboot is the
# first thing anyone would try, and Docker restarts every service
# (`restart: unless-stopped`) when the instance comes back.
resource "aws_cloudwatch_metric_alarm" "instance_status" {
  alarm_name          = "book-maker-status-check-instance"
  alarm_description   = "The book-maker instance's OS is not answering EC2's status check. Rebooting it; see docs/deployment.md, Monitoring and alerts."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  dimensions          = { InstanceId = aws_instance.book_maker.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = ["arn:aws:automate:${data.aws_region.current.name}:ec2:reboot", aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# The t3.medium runs in T3's default unlimited credit mode: it earns 24 CPU
# credits an hour (20% of each of its two vCPUs), banks at most 576, and once the
# bank is empty every minute above baseline is billed as surplus credit at
# $0.05 per vCPU-hour — about $58 a month at a sustained 100% on both vCPUs,
# over a quarter of the whole budget. 50 credits is about half an hour of both
# vCPUs flat out. The
# metric is published every five minutes; fifteen minutes under the line is a
# runaway process or a real load change, not one compile. A freshly launched
# instance starts near zero and trips this once until it has banked credits.
resource "aws_cloudwatch_metric_alarm" "cpu_credits" {
  alarm_name          = "book-maker-cpu-credits-low"
  alarm_description   = "The book-maker instance has nearly spent its CPU credits; past zero, CPU above baseline is billed as surplus. See docs/deployment.md, Monitoring and alerts."
  namespace           = "AWS/EC2"
  metric_name         = "CPUCreditBalance"
  dimensions          = { InstanceId = aws_instance.book_maker.id }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 50
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
