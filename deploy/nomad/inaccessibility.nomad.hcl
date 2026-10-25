# Inaccessibility on the outpost: one stateless container, reports in RGW.
#
#   nomad var put nomad/jobs/inaccessibility access_token=<passphrase> \
#       s3_access_key=<rgw key> s3_secret_key=<rgw secret>
#   nomad job run deploy/nomad/inaccessibility.nomad.hcl
#
# Storage is S3 (Ceph RGW, ADR 0009) so the allocation can land on any Linux
# node and losing it loses nothing. For a single-node setup without RGW, swap
# STORAGE=fs plus a host volume mounted at /data.

variable "image" {
  type    = string
  default = "ghcr.io/justizin/inaccessibility:0.1.0"
}

variable "bucket" {
  type    = string
  default = "inaccessibility"
}

variable "s3_endpoint" {
  type    = string
  default = "http://127.0.0.1:7480"
}

job "inaccessibility" {
  datacenters = ["home"]
  type        = "service"

  group "web" {
    count = 1

    constraint {
      attribute = "${meta.os}"
      value     = "linux"
    }

    network {
      port "http" {
        to = 8080
      }
    }

    service {
      name     = "inaccessibility"
      port     = "http"
      provider = "nomad"
      tags     = ["http"]

      check {
        type     = "http"
        path     = "/api/health"
        interval = "30s"
        timeout  = "3s"
      }
    }

    restart {
      attempts = 5
      interval = "10m"
      delay    = "15s"
      mode     = "delay"
    }

    task "server" {
      driver = "docker"

      config {
        image = var.image
        ports = ["http"]
      }

      template {
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/inaccessibility" }}
          ACCESS_TOKEN={{ .access_token }}
          AWS_ACCESS_KEY_ID={{ .s3_access_key }}
          AWS_SECRET_ACCESS_KEY={{ .s3_secret_key }}
          {{ end }}
        EOT
        destination = "secrets/app.env"
        env         = true
        change_mode = "restart"
      }

      env {
        STORAGE     = "s3"
        S3_ENDPOINT = var.s3_endpoint
        S3_BUCKET   = var.bucket
        PORT        = "8080"
      }

      resources {
        cpu    = 200
        memory = 192
      }
    }
  }
}
