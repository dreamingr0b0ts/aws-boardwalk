# The textbook build: one VPC, two AZs, three subnet tiers. The deliberate
# absence is NAT — private subnets have NO route to the internet at all, and
# the gateway endpoints in endpoints.tf are how private workloads still reach
# S3/DynamoDB for $0 (the no-NAT cost pattern this plank exists to prove).

locals {
  vpc_cidr = "10.42.0.0/16"
  azs      = ["${local.region}a", "${local.region}b"]

  # tier → per-AZ CIDRs
  public_cidrs = ["10.42.0.0/24", "10.42.1.0/24"]
  app_cidrs    = ["10.42.10.0/24", "10.42.11.0/24"]
  data_cidrs   = ["10.42.20.0/24", "10.42.21.0/24"]
}

resource "aws_vpc" "lab" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # required for interface-endpoint private DNS

  tags = { Name = "${local.prefix}-vpc" }
}

# Adopting the default SG strips every rule from it — nothing should ever use
# the default group, and now nothing can communicate through it either.
resource "aws_default_security_group" "locked" {
  vpc_id = aws_vpc.lab.id

  tags = { Name = "${local.prefix}-default-sg-locked" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.lab.id

  tags = { Name = "${local.prefix}-igw" }
}

# ── subnets ───────────────────────────────────────────────────────────────────
# map_public_ip_on_launch stays false even on public subnets: public exposure
# is granted per-instance (ec2.tf), never as a subnet default.

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.lab.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = { Name = "${local.prefix}-public-${local.azs[count.index]}", tier = "public" }
}

resource "aws_subnet" "app" {
  count             = 2
  vpc_id            = aws_vpc.lab.id
  cidr_block        = local.app_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = { Name = "${local.prefix}-app-${local.azs[count.index]}", tier = "app" }
}

resource "aws_subnet" "data" {
  count             = 2
  vpc_id            = aws_vpc.lab.id
  cidr_block        = local.data_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = { Name = "${local.prefix}-data-${local.azs[count.index]}", tier = "data" }
}

# ── routing ───────────────────────────────────────────────────────────────────
# Public: default route to the IGW. App/data: no default route AT ALL — the
# only non-local routes are the S3/DynamoDB prefix lists the gateway endpoints
# inject (endpoints.tf). That empty space where a NAT gateway would sit is
# the exhibit: $0.045/hr + per-GB, avoided by design.

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = { Name = "${local.prefix}-public-rt" }
}

resource "aws_route_table" "app" {
  vpc_id = aws_vpc.lab.id

  tags = { Name = "${local.prefix}-app-rt" }
}

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.lab.id

  tags = { Name = "${local.prefix}-data-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "app" {
  count          = 2
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app.id
}

resource "aws_route_table_association" "data" {
  count          = 2
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}
