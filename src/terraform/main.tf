provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
  default_tags {
    tags = {
      app-id      = "meetingbot"
      app-purpose = "meeting bot"
      environment = "${terraform.workspace == "default" ? "prod" : terraform.workspace}"
      pii         = "yes"
    }
  }
}

data "aws_availability_zones" "available" {}

locals {
  name = "meetingbot"

  vpc_cidr = "10.0.0.0/16"
  azs      = slice(data.aws_availability_zones.available.names, 0, 3)
  ecrs     = ["backend", "teams-bot", "zoom-bot", "meets-bot"]
}

terraform {
  backend "s3" {
    encrypt = true
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = local.name
  cidr = local.vpc_cidr

  azs             = local.azs
  private_subnets = [for k, v in local.azs : cidrsubnet(local.vpc_cidr, 4, k)]
  public_subnets  = [for k, v in local.azs : cidrsubnet(local.vpc_cidr, 8, k + 48)]

  #   enable_nat_gateway = true
  #   single_nat_gateway = true
}

module "api_gateway" {
  source = "terraform-aws-modules/apigateway-v2/aws"

  # API
  cors_configuration = {
    allow_headers = ["content-type", "x-amz-date", "authorization", "x-api-key", "x-amz-security-token", "x-amz-user-agent"]
    allow_methods = ["*"]
    allow_origins = ["*"]
  }

  description = "HTTP API Gateway with VPC links"
  name        = local.name

  # Custom Domain
  create_domain_name = false

  # Routes & Integration(s)
  routes = {
    "ANY /" = {
      integration = {
        connection_type = "VPC_LINK"
        uri             = module.alb.listeners["default"].arn
        type            = "HTTP_PROXY"
        method          = "ANY"
        vpc_link_key    = "my-vpc"
      }
    }
  }

  # VPC Link
  vpc_links = {
    my-vpc = {
      name               = local.name
      security_group_ids = [module.api_gateway_security_group.security_group_id]
      subnet_ids         = module.vpc.private_subnets
    }
  }
}

module "api_gateway_security_group" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "~> 5.0"

  name        = local.name
  description = "API Gateway group for example usage"
  vpc_id      = module.vpc.vpc_id

  ingress_cidr_blocks = ["0.0.0.0/0"]
  ingress_rules       = ["http-80-tcp"]

  egress_rules = ["all-all"]
}

module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "~> 9.0"

  name = local.name

  vpc_id  = module.vpc.vpc_id
  subnets = module.vpc.private_subnets

  # Disable for example
  enable_deletion_protection = false

  security_group_ingress_rules = {
    all_http = {
      from_port   = 80
      to_port     = 80
      ip_protocol = "tcp"
      description = "HTTP web traffic"
      cidr_ipv4   = "0.0.0.0/0"
    }
    all_https = {
      from_port   = 443
      to_port     = 443
      ip_protocol = "tcp"
      description = "HTTPS web traffic"
      cidr_ipv4   = "0.0.0.0/0"
    }
  }

  listeners = {
    default = {
      port     = 80
      protocol = "HTTP"
      fixed_response = {
        content_type = "text/plain"
        message_body = "Hello, World!"
        status_code  = "200"
      }
    }
  }
}

module "ecr" {
  source = "terraform-aws-modules/ecr/aws"

  for_each = toset(local.ecrs)

  repository_name = "${local.name}-${each.key}"

  repository_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1,
        description  = "Keep last 30 images",
        selection = {
          tagStatus     = "tagged",
          tagPrefixList = ["v"],
          countType     = "imageCountMoreThan",
          countNumber   = 30
        },
        action = {
          type = "expire"
        }
      }
    ]
  })
}
