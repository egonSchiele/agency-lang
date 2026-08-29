import datetime as dt
import os
import re
import subprocess
import sys

CERT = os.path.join("ssl", "server.crt")
if not os.path.exists(CERT):
    print("certificate missing")
    sys.exit(1)
out = subprocess.run(["openssl", "x509", "-in", CERT, "-noout", "-subject", "-enddate"], capture_output=True, text=True)
if out.returncode != 0:
    print("certificate could not be loaded")
    sys.exit(1)
cn = re.search(r"CN\s*=\s*([^,/\n]+)", out.stdout).group(1).strip()
end = re.search(r"notAfter=(.*)", out.stdout).group(1).strip()
expiry = dt.datetime.strptime(end, "%b %d %H:%M:%S %Y %Z").strftime("%Y-%m-%d")
print(f"Common Name: {cn}")
print(f"Expires: {expiry}")
print("Certificate verification successful")
