variable "identifier" { type = string }
variable "engine" { type = string }
variable "engine_version" { type = string }
variable "instance_class" { type = string }
variable "allocated_storage" { type = number }
variable "max_allocated_storage" { type = number }
variable "storage_type" { type = string }
variable "storage_encrypted" { type = bool }
variable "db_name" { type = string }
variable "username" { type = string }
variable "port" { type = number }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "vpc_security_group_ids" { type = list(string) }
variable "multi_az" { type = bool }
variable "backup_retention_period" { type = number }
variable "skip_final_snapshot" { type = bool }
variable "performance_insights_enabled" { type = bool }
variable "monitoring_interval" { type = number }
variable "parameters" { type = list(map(string)) }
variable "tags" { type = map(string) }

resource "random_password" "master" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.identifier}-subnet-group"
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_db_parameter_group" "main" {
  name   = "${var.identifier}-params"
  family = "postgres15"

  dynamic "parameter" {
    for_each = var.parameters
    content {
      name         = parameter.value.name
      value        = parameter.value.value
      apply_method = lookup(parameter.value, "apply_method", "pending-reboot")
    }
  }
  tags = var.tags
}

resource "aws_db_instance" "main" {
  identifier     = var.identifier
  engine         = var.engine
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = var.storage_type
  storage_encrypted     = var.storage_encrypted

  db_name  = var.db_name
  username = var.username
  password = random_password.master.result
  port     = var.port

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = var.vpc_security_group_ids
  parameter_group_name   = aws_db_parameter_group.main.name

  multi_az            = var.multi_az
  publicly_accessible = false

  backup_retention_period = var.backup_retention_period
  backup_window           = "02:00-03:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = "${var.identifier}-final"
  copy_tags_to_snapshot     = true
  deletion_protection       = true

  performance_insights_enabled = var.performance_insights_enabled
  monitoring_interval          = var.monitoring_interval
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true

  tags = var.tags
}

output "endpoint" {
  value = aws_db_instance.main.endpoint
}

output "password" {
  value     = random_password.master.result
  sensitive = true
}
