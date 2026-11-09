"""L0-1 environment qualification. The runner starts it through guard.py as the run user: python -I -B guard.py <config.json>.

Arguments: --expect <expect.json> --out <report.json>.
It imports each direct requirement of the See-through run path, reads the installed distributions, and (when requireCuda is
true) runs one small operation on the GPU with PyTorch. It loads no model file and uses no network.
The report is one JSON file. Exit status: 0 PASS, 1 FAIL, 2 usage error.

Why Python: the check must import the installed Python packages in the same interpreter that See-through uses.
"""

import importlib
import importlib.metadata
import json
import re
import sys

FORMAT = "aigg.l0-seethrough-qualify/0.1"


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def error_text(error):
    return (type(error).__name__ + ": " + str(error))[:300]


def main():
    args = sys.argv[1:]
    if len(args) != 4 or args[0] != "--expect" or args[2] != "--out":
        sys.stderr.write("Usage: qualify.py --expect <expect.json> --out <report.json>\n")
        sys.exit(2)
    with open(args[1], "r", encoding="utf-8") as handle:
        expect = json.load(handle)
    problems = []
    report = {
        "format": FORMAT,
        "python": sys.version.split()[0],
        "modules": [],
        "distributions": {},
        "torch": None,
        "problems": problems,
    }
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if name:
            report["distributions"][normalize(name)] = distribution.version
    for name, version in sorted(expect.get("packages", {}).items()):
        actual = report["distributions"].get(name)
        if actual != version:
            problems.append("version " + name + ": " + str(actual) + " (expected " + version + ")")
    for item in expect.get("modules", []):
        entry = {"distribution": item["distribution"], "module": item["module"]}
        try:
            module = importlib.import_module(item["module"])
            entry["status"] = "PASS"
            entry["version"] = str(getattr(module, "__version__", ""))
        except Exception as error:  # Each import failure is a result, not a crash of the check.
            entry["status"] = "FAIL"
            entry["error"] = error_text(error)
            problems.append("import " + item["module"] + ": " + entry["error"])
        report["modules"].append(entry)
    if expect.get("requireCuda"):
        info = {"cuda": None, "cudaAvailable": False, "operation": "NOT_RUN"}
        report["torch"] = info
        try:
            import torch

            info["version"] = torch.__version__
            info["cuda"] = torch.version.cuda
            info["cudnn"] = torch.backends.cudnn.version()
            info["cudaAvailable"] = bool(torch.cuda.is_available())
            if info["cuda"] != expect.get("cuda"):
                problems.append("torch CUDA " + str(info["cuda"]) + " (expected " + str(expect.get("cuda")) + ")")
            if info["cudaAvailable"]:
                info["device"] = torch.cuda.get_device_name(0)
                info["capability"] = list(torch.cuda.get_device_capability(0))
                value = torch.ones(4, device="cuda")
                total = float((value + value).sum().item())
                torch.cuda.synchronize()
                info["operation"] = "PASS" if total == 8.0 else "FAIL"
                if total != 8.0:
                    problems.append("CUDA operation gave " + str(total))
            else:
                problems.append("CUDA is not available to PyTorch")
        except Exception as error:  # A CUDA or import error is a result of the check.
            info["operation"] = "FAIL"
            info["error"] = error_text(error)
            problems.append("torch: " + info["error"])
    report["status"] = "PASS" if not problems else "FAIL"
    with open(args[3], "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    main()
