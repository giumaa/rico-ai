#!/usr/bin/env python3
"""Print the Kaggle username that belongs to the current credentials (KGAT_ access token or legacy key).

Used by train-kaggle.yml when the KAGGLE_USERNAME secret is missing: the kernel slug needs `<owner>/<slug>`.
Never prints credentials; prints only the username (public) on stdout, diagnostics on stderr.
"""
import csv
import io
import re
import subprocess
import sys


def kaggle(*args: str) -> str:
    r = subprocess.run(["kaggle", *args], capture_output=True, text=True, timeout=180)
    return r.stdout if r.returncode == 0 else ""


def valid(u) -> bool:
    return isinstance(u, str) and re.fullmatch(r"[A-Za-z0-9._-]{2,64}", u.strip() or "") is not None


def from_api() -> str | None:
    try:
        from kaggle.api.kaggle_api_extended import KaggleApi
        api = KaggleApi()
        api.authenticate()
        for getter in (lambda: api.get_config_value("username"), lambda: api.config_values.get("username"),
                       lambda: getattr(api, "username", None)):
            try:
                u = getter()
            except Exception:  # noqa: BLE001
                continue
            if valid(u):
                return u.strip()
    except Exception as exc:  # noqa: BLE001
        print(f"api lookup failed: {type(exc).__name__}", file=sys.stderr)
    return None


def from_config_view() -> str | None:
    m = re.search(r"(?m)^\s*-?\s*username:\s*(\S+)", kaggle("config", "view"))
    return m.group(1) if m and valid(m.group(1)) else None


def from_owned_items() -> str | None:
    for args in (("kernels", "list", "--mine", "--csv", "--page-size", "5"),
                 ("datasets", "list", "--mine", "--csv", "--page-size", "5")):
        out = kaggle(*args)
        if not out.strip():
            continue
        for row in csv.DictReader(io.StringIO(out)):
            ref = row.get("ref") or ""
            if "/" in ref and valid(ref.split("/")[0]):
                return ref.split("/")[0]
    return None


if __name__ == "__main__":
    for fn in (from_api, from_config_view, from_owned_items):
        u = fn()
        if u:
            print(u)
            sys.exit(0)
    print("could not resolve the Kaggle username from the token", file=sys.stderr)
    sys.exit(1)
