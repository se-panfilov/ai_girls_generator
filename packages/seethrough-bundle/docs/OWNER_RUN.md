# L0-1 owner run instructions

**Draft.** These steps are for the owner. Do not start them before the independent audit of the bundle and a separate owner permission for the first GPU run.
The budget ceiling of the experiment is $5. This ceiling is a maximum, not a permission to spend.

Stop at the first FAIL or BLOCKED. Do not change a setting, a version, a model, or an argument to get past it. Copy the evidence, terminate the Pod, and report the code.

## 0. On your computer, before the Pod

1. Build or get the bundle directory and check it: `cd <bundle>` and `shasum -a 256 -c SHA256SUMS`.
2. Compare `shasum -a 256 SHA256SUMS` with the value in the pull request. They must be equal.
3. Get the input from the project file `l0-input-v1.tar.gz`: `tar -xzf l0-input-v1.tar.gz l0-input-v1/concept-mirrored.png`.
   Check it: `shasum -a 256 l0-input-v1/concept-mirrored.png` must give `175b3292437165380dd6cfb07c2b46b05a7dee11f90cd24307ba05326e8eae8b`.
   Copy only this file to the Pod. Do not copy `concept-original.png`, the Akane PSD files, or the Akane archive.

## 1. Start the Pod

| Setting     | Value                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GPU         | One RTX A5000 24 GB (or another NVIDIA GPU with 16 GB or more). On-Demand.                                                              |
| Image       | A template whose image is based on Ubuntu 24.04, so that `python3.12` is present. If no such template is available, the run is BLOCKED. |
| Disk        | A volume of 40 GB or more for `/workspace`.                                                                                             |
| Ports       | Remove all HTTP ports. Keep only TCP 22 for SSH with your key.                                                                          |
| Environment | No environment variables with tokens or keys. No Hugging Face token. No cloud credentials.                                              |

Write down the time and the price per hour. Stop when the cost comes near the ceiling.

## 2. Check the host

Connect: `ssh -p <PORT> -i ~/.ssh/<key> root@<IP>`. Then run:

```sh
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
python3.12 --version
git --version
node --version
df -h /workspace
```

Required: memory 16384 MiB or more, driver 570 or later, Python 3.12.x, Node.js 22.12.0 or later, 40 GB free.
If Node.js is missing or older, install the official Linux x64 build from nodejs.org and check its archive against the `SHASUMS256.txt` file of the same release before you extract it.
If `python3.12` or the driver does not meet the requirement, the run is BLOCKED. Terminate the Pod and report it.

## 3. Copy the bundle and the input

From your computer:

```sh
scp -P <PORT> -i ~/.ssh/<key> -r <bundle> root@<IP>:/workspace/l0-1-bundle
scp -P <PORT> -i ~/.ssh/<key> l0-input-v1/concept-mirrored.png root@<IP>:/workspace/concept-mirrored.png
```

On the Pod:

```sh
mkdir -m 700 /workspace/l0-1
sh /workspace/l0-1-bundle/run.sh preflight --work /workspace/l0-1 --input /workspace/concept-mirrored.png
```

The expected result is INCOMPLETE (exit status 3): the code, wheels, models, and venv are missing. Every other check must be PASS. FAIL stops here.

## 4. Prepare (downloads, no model run)

```sh
sh /workspace/l0-1-bundle/run.sh prepare --work /workspace/l0-1
```

It gets See-through at the pinned commit, 79 wheels (about 4.1 GB), and the model files (about 13.4 GB), and checks each file. Then it makes the venv and installs the wheels offline.
It does not run See-through. If it stops, run it again: it keeps the checked files and never replaces a file with other content.
Then run preflight again. The result must be READY (exit status 0):

```sh
sh /workspace/l0-1-bundle/run.sh preflight --work /workspace/l0-1 --input /workspace/concept-mirrored.png
sh /workspace/l0-1-bundle/run.sh gpu --work /workspace/l0-1
```

## 5. Run once

```sh
sh /workspace/l0-1-bundle/run.sh run --work /workspace/l0-1 --input /workspace/concept-mirrored.png
sh /workspace/l0-1-bundle/run.sh status --work /workspace/l0-1
```

The run stops after 3600 s. The result is PASS or FAIL. Each problem has a code, for example `E_GUARD_DENIED` or `E_FALLBACK_SUSPECTED`.
Do not run it again in the same work directory. A second run is a new owner decision.

## 6. Copy the evidence

On the Pod:

```sh
cd /workspace/l0-1 && tar -czf /workspace/l0-1-results.tar.gz evidence output
```

On your computer:

```sh
scp -P <PORT> -i ~/.ssh/<key> root@<IP>:/workspace/l0-1-results.tar.gz .
mkdir l0-1-results && tar -xzf l0-1-results.tar.gz -C l0-1-results
cd l0-1-results && shasum -a 256 -c evidence/SHA256SUMS
```

`evidence/` has `result.json`, `runner.log`, `guard.jsonl`, `see-through.log`, `install.log`, `git.log`, and `SHA256SUMS`. `output/` has the PSD files and the part images.
Put the archive in the project files. Do not commit it to Git.

## 7. Stop the Pod

Terminate the Pod (not only Stop). A stopped Pod keeps its volume and its cost. Check in the Runpod console that the Pod and its volume are gone.
Write down the end time and the cost.
