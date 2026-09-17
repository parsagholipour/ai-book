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

resource "aws_security_group" "book_maker" {
  name        = "book-maker"
  description = "HTTP/HTTPS from the book-maker subnet only"
  vpc_id      = aws_vpc.book_maker.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [aws_subnet.book_maker.cidr_block]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_subnet.book_maker.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "book_maker" {
  ami                         = "ami-0303e2e4a29f041a3"
  instance_type               = "t3.nano"
  subnet_id                   = aws_subnet.book_maker.id
  vpc_security_group_ids      = [aws_security_group.book_maker.id]
  key_name                    = aws_key_pair.deploy.key_name
  associate_public_ip_address = true

  root_block_device {
    volume_type = "gp3"
    volume_size = 8
  }

  metadata_options {
    http_tokens = "required"
  }

  tags = {
    Name = "book-maker"
  }
}

output "public_ip" {
  value = aws_instance.book_maker.public_ip
}
