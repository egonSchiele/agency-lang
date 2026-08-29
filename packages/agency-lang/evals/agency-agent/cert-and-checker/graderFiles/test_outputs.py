"""Checks for cert-and-checker. openssl reads the files; the checker runs
under python3 -I, which ignores site-packages, so a pip-installed import
fails here even though it worked for the agent."""
import datetime as dt
import os
import re
import stat
import subprocess
import sys

WORKDIR = os.environ.get("WORKDIR", os.getcwd())
SSL = os.path.join(WORKDIR, "ssl")
ORG = "Northwind Internal"
CN = "build.northwind.internal"


def openssl(*args):
    result = subprocess.run(["openssl", *args], capture_output=True, text=True, cwd=WORKDIR)
    assert result.returncode == 0, f"openssl {' '.join(args)} failed:\n{result.stderr[-800:]}"
    return result.stdout


def cert_dates():
    text = openssl("x509", "-in", "ssl/server.crt", "-noout", "-dates")
    fmt = "%b %d %H:%M:%S %Y %Z"
    before = dt.datetime.strptime(re.search(r"notBefore=(.*)", text).group(1).strip(), fmt)
    after = dt.datetime.strptime(re.search(r"notAfter=(.*)", text).group(1).strip(), fmt)
    return before, after


def test_key_and_cert():
    for name in ("server.key", "server.crt", "server.pem"):
        assert os.path.exists(os.path.join(SSL, name)), f"ssl/{name} is missing"
    key_text = openssl("pkey", "-in", "ssl/server.key", "-noout", "-text")
    assert "prime256v1" in key_text or "P-256" in key_text, "server.key is not an EC P-256 key"
    mode = stat.S_IMODE(os.stat(os.path.join(SSL, "server.key")).st_mode)
    assert mode == 0o600, f"server.key mode is {oct(mode)}, want 0o600"
    subject = openssl("x509", "-in", "ssl/server.crt", "-noout", "-subject")
    issuer = openssl("x509", "-in", "ssl/server.crt", "-noout", "-issuer")
    assert ORG in subject and CN in subject, f"subject is {subject.strip()}"
    assert subject.split("=", 1)[1] == issuer.split("=", 1)[1], "certificate is not self-signed"
    openssl("verify", "-CAfile", "ssl/server.crt", "ssl/server.crt")
    key_pub = openssl("pkey", "-in", "ssl/server.key", "-pubout")
    cert_pub = openssl("x509", "-in", "ssl/server.crt", "-noout", "-pubkey")
    assert key_pub.strip() == cert_pub.strip(), "server.crt was not issued for server.key"
    before, after = cert_dates()
    days = (after - before).days
    assert 89 <= days <= 91, f"certificate is valid for {days} days, want 90"
    pem = open(os.path.join(SSL, "server.pem")).read()
    assert "PRIVATE KEY" in pem and "BEGIN CERTIFICATE" in pem, "server.pem lacks the key or the certificate"


def test_verification_file():
    path = os.path.join(SSL, "verification.txt")
    assert os.path.exists(path), "ssl/verification.txt is missing"
    text = open(path).read()
    assert CN in text, "verification.txt does not show the subject"
    fingerprint = openssl("x509", "-in", "ssl/server.crt", "-noout", "-fingerprint", "-sha256")
    digest = fingerprint.split("=", 1)[1].strip().replace(":", "").lower()
    assert digest in text.replace(":", "").lower(), "verification.txt does not hold the SHA-256 fingerprint"
    _before, after = cert_dates()
    assert after.strftime("%Y-%m-%d") in text or after.strftime("%b %d") in text, "verification.txt does not show the expiry date"


def test_checker_runs_clean():
    checker = os.path.join(WORKDIR, "check_cert.py")
    assert os.path.exists(checker), "check_cert.py is missing"
    env = {"PATH": os.environ.get("PATH", "")}
    result = subprocess.run([sys.executable, "-I", checker], cwd=WORKDIR, capture_output=True, text=True, env=env, timeout=60)
    assert result.returncode == 0, f"check_cert.py exited {result.returncode} in isolated mode:\n{result.stderr[-1200:]}"
    _before, after = cert_dates()
    assert CN in result.stdout, "checker output lacks the Common Name"
    assert after.strftime("%Y-%m-%d") in result.stdout, "checker output lacks the expiry date as YYYY-MM-DD"
    assert "Certificate verification successful" in result.stdout, "checker did not print the success line"
