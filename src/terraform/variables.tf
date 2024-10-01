variable "aws_profile" {
  type        = string
  description = "The AWS profile to use"
}

variable "aws_region" {
  type        = string
  description = "The AWS region to deploy resources"
  nullable    = true
}
