#!/usr/bin/env python3
"""Send a non-secret release bundle to EC2 and wait for deployment to finish."""
import base64
import io
import json
import os
import shlex
import subprocess
import tarfile
import time


def aws(*args):
    result = subprocess.run(
        ["aws", *args, "--output", "json"], capture_output=True, text=True
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout)


def main():
    instance = os.environ["INSTANCE_ID"]
    # IAM attachment/SSM registration can lag the successful Terraform apply.
    for _ in range(60):
        result = aws("ssm", "describe-instance-information", "--filters",
                     json.dumps([{"Key": "InstanceIds", "Values": [instance]}]))
        if any(i["PingStatus"] == "Online" for i in result["InstanceInformationList"]):
            break
        time.sleep(10)
    else:
        raise RuntimeError("EC2 is not online in SSM. Check the agent, instance role, and outbound HTTPS.")

    bundle = io.BytesIO()
    with tarfile.open(fileobj=bundle, mode="w:gz") as archive:
        for path in ["docker-compose.production.yml", "deploy/Caddyfile",
                     "scripts/install-production-docker.sh", "scripts/deploy-production.sh"]:
            archive.add(path, arcname=path)
    encoded = base64.b64encode(bundle.getvalue()).decode("ascii")
    release = "/opt/book-maker/releases/" + os.environ["RELEASE_ID"]
    args = [os.environ[name] for name in
            ["AWS_REGION", "ENV_PARAMETER", "APP_IMAGE", "WEB_IMAGE", "S3_BUCKET"]]
    command = "\n".join([
        "set -eu", "umask 077", f"mkdir -p {shlex.quote(release)}",
        f"cd {shlex.quote(release)}",
        f"printf %s {shlex.quote(encoded)} | base64 -d | tar -xz",
        "bash scripts/install-production-docker.sh",
        "bash scripts/deploy-production.sh " + shlex.join(args),
    ])
    result = aws("ssm", "send-command", "--instance-ids", instance,
                 "--document-name", "AWS-RunShellScript", "--timeout-seconds", "600",
                 "--parameters", json.dumps({"commands": [command], "executionTimeout": ["1800"]}))
    command_id = result["Command"]["CommandId"]
    print(f"SSM deployment command: {command_id}", flush=True)
    deadline = time.monotonic() + 2400
    while time.monotonic() < deadline:
        try:
            result = aws("ssm", "get-command-invocation", "--command-id", command_id,
                         "--instance-id", instance)
        except RuntimeError as error:
            if "InvocationDoesNotExist" not in str(error):
                raise
            time.sleep(10)
            continue
        status = result["Status"]
        if status not in ["Pending", "InProgress", "Delayed"]:
            print(result.get("StandardOutputContent", ""))
            print(result.get("StandardErrorContent", ""))
            if status != "Success":
                raise RuntimeError(f"SSM deployment {command_id} finished with {status}")
            return
        time.sleep(10)
    raise RuntimeError(f"Timed out waiting for SSM command {command_id}; inspect it before retrying.")


if __name__ == "__main__":
    main()
