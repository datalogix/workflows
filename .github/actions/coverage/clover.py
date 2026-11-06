"""Reads a Clover report for coverage.sh: prints the project's elements and covered elements, then one line per file
not fully covered (covered, elements and name, separated by tabs), or "invalid" when it is not a Clover report with
project metrics. Python is on every GitHub-hosted runner; xmllint is not."""

import sys
import xml.etree.ElementTree as ET


def whole(value):
    return value is not None and value.isdigit()


try:
    root = ET.parse(sys.argv[1]).getroot()
except (ET.ParseError, OSError):
    print("invalid")
    sys.exit(0)

metrics = root.find("project/metrics") if root.tag == "coverage" else None
if metrics is None or not (whole(metrics.get("elements")) and whole(metrics.get("coveredelements"))):
    print("invalid")
    sys.exit(0)

print(metrics.get("elements"), metrics.get("coveredelements"))
for file in root.iter("file"):
    file_metrics = file.find("metrics")
    if file_metrics is not None and file_metrics.get("coveredelements") != file_metrics.get("elements"):
        print(f"{file_metrics.get('coveredelements')}\t{file_metrics.get('elements')}\t{file.get('name', '')}")
