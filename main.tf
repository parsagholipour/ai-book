terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Bucket is created by scripts/ensure-tf-backend.sh (CI and first local init).
  backend "s3" {
    bucket       = "parsagholipour-ai-book-tfstate"
    key          = "aws/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "eu-central-1"
}

variable "ssh_public_key" {
  type        = string
  description = "OpenSSH public key for the EC2 instance. Override in CI with TF_VAR_ssh_public_key if needed."
  default     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGacYmYHBz8/vu8jl2GNYKro+puK9bHJB7QoVb+ISnJa parsa_gholipour@yahoo.com"
}

variable "instance_type" {
  type        = string
  description = "EC2 size for the production Docker stack (t3.small has 2 GiB RAM)."
  default     = "t3.small"
}

variable "root_volume_size" {
  type        = number
  description = "Root disk size in GiB for Docker, PostgreSQL, Redis, and temporary rendering files. Durable files live in S3."
  default     = 20
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "book_maker" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "book-maker"
  }
}

resource "aws_internet_gateway" "book_maker" {
  vpc_id = aws_vpc.book_maker.id

  tags = {
    Name = "book-maker"
  }
}

resource "aws_subnet" "book_maker" {
  vpc_id                  = aws_vpc.book_maker.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "book-maker"
  }
}

resource "aws_route_table" "book_maker" {
  vpc_id = aws_vpc.book_maker.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.book_maker.id
  }

  tags = {
    Name = "book-maker"
  }
}

resource "aws_route_table_association" "book_maker" {
  subnet_id      = aws_subnet.book_maker.id
  route_table_id = aws_route_table.book_maker.id
}

resource "aws_key_pair" "deploy" {
  key_name   = "book-maker"
  public_key = var.ssh_public_key
}

# Only the Caddy edge in docker-compose.production.yml is reachable from the
# internet. SSH, PostgreSQL, Redis and the API stay closed; deployment uses SSM.
resource "aws_security_group" "book_maker" {
  # `description` forces a new group, and a static `name` cannot coexist with
  # its replacement, so the group is created before the old one is destroyed
  # and the instance is moved across in place.
  name_prefix = "book-maker-"
  description = "Public HTTP/HTTPS to the Caddy edge; no other inbound traffic"
  vpc_id      = aws_vpc.book_maker.id

  ingress {
    description = "HTTP (ACME HTTP-01 and redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "book-maker"
  }
}

# associate_public_ip_address stays true: changing it replaces the instance, and
# the Elastic IP association below supersedes the auto-assigned address anyway.
resource "aws_instance" "book_maker" {
  ami                         = "ami-0303e2e4a29f041a3"
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.book_maker.id
  vpc_security_group_ids      = [aws_security_group.book_maker.id]
  key_name                    = aws_key_pair.deploy.key_name
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.book_maker.name

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # Allow app containers to use the instance role.
  }

  tags = {
    Name = "book-maker"
  }
}

# The address the tomeza.ravanix.app A record at Hetzner points to. The
# instance's auto-assigned public IP changes on every stop/start; this one
# survives resizing and even replacing the instance as long as the
# association is re-applied.
resource "aws_eip" "book_maker" {
  domain     = "vpc"
  depends_on = [aws_internet_gateway.book_maker]

  tags = {
    Name = "book-maker"
  }
}

resource "aws_eip_association" "book_maker" {
  instance_id   = aws_instance.book_maker.id
  allocation_id = aws_eip.book_maker.id
}

output "elastic_ip" {
  value = aws_eip.book_maker.public_ip
}

# Kept for existing callers; it is the Elastic IP, never the ephemeral address.
output "public_ip" {
  value = aws_eip.book_maker.public_ip
}
