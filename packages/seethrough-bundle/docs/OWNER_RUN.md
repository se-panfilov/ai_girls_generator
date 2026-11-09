# L0-1 owner run instructions

**Draft.** These steps are for the owner. Do not start them before the independent audit of the bundle and the owner permission for each gate below.
The budget ceiling of the experiment is $5. This ceiling is a maximum, not a permission to spend.

The run has four gates. Each gate needs its own owner permission. You can stop after each gate: collect the evidence (section 7) and terminate the Pod (section 8).

| Gate | Stage                     | What happens                                                                       | Third-party code                                         |
| ---- | ------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| G1   | Pod and host setup        | Rent the Pod, make the run user, close credential files.                           | None                                                     |
| G2   | Preparation               | Downloads from pinned sources, offline installation of the wheels as the run user. | pip installs wheels (no wheel code runs at installation) |
| G3   | Environment qualification | `qualify`: imports, exact versions, one small CUDA operation. No model is loaded.  | Python packages are imported and run as the run user     |
| G4   | Inference (the L0-1 run)  | `run`: one See-through decomposition of `concept-mirrored.png`.                    | See-through and the models run as the run user           |

Stop at the first FAIL or BLOCKED. Do not change a setting, a version, a model, or an argument to get past it. Collect the evidence, terminate the Pod, and report the code.

## 0. On your computer, before the Pod

1. Build or get the bundle directory and check it: `cd <bundle>` and `shasum -a 256 -c SHA256SUMS`.
2. Compare `shasum -a 256 SHA256SUMS` with the value in the pull request. They must be equal.
3. Get the input from the project file `l0-input-v1.tar.gz`: `tar -xzf l0-input-v1.tar.gz l0-input-v1/concept-mirrored.png`.
   Check it: `shasum -a 256 l0-input-v1/concept-mirrored.png` must give `175b3292437165380dd6cfb07c2b46b05a7dee11f90cd24307ba05326e8eae8b`.
   Copy only this file to the Pod. Do not copy `concept-original.png`, the Akane PSD files, or the Akane archive.

## 1. Start the Pod (G1)

| Setting     | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GPU         | One RTX A5000 24 GB (or another NVIDIA GPU with 16 GB or more). On-Demand.                                                       |
| Image       | A template whose image is based on Ubuntu 24.04, so that `python3.12` and `unshare` (util-linux 2.39) are present. Else BLOCKED. |
| Disk        | Volume for `/workspace`: **minimum 40 GB**, **suggested 60 GB** (headroom for the first full installation). See the table below. |
| Ports       | Remove all HTTP ports. Keep only TCP 22 for SSH with your key.                                                                   |
| Environment | No environment variables with tokens or keys. No Hugging Face token. No cloud credentials.                                       |

| Disk use (estimate)          | Size            |
| ---------------------------- | --------------- |
| Model files                  | 13.4 GB         |
| Wheels                       | 4.1 GB          |
| venv (installed wheels)      | up to 12 GiB    |
| Margin that prepare requires | 2 GiB           |
| Free space that run requires | 10 GiB          |
| **Required minimum**         | **about 40 GB** |

The extra 20 GB of the suggested volume costs little for a few hours (check the volume price in the console). It is headroom, not a requirement.
Write down the start time and the price per hour. Stop when the cost comes near the ceiling.

## 2. Set up the host (G1)

Connect: `ssh -p <PORT> -i ~/.ssh/<key> root@<IP>`. You are root. The runner also starts as root, but it starts every third-party Python process as the run user `aigg-l0`.

```sh
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
python3.12 --version
git --version
node --version
unshare --version
df -h /workspace
```

Required: memory 16384 MiB or more, driver 570 or later, Python 3.12.x, Node.js 22.12.0 or later, util-linux 2.38 or later, 40 GB free.
If Node.js is missing or older, install the official Linux x64 build from nodejs.org and check its archive against the `SHASUMS256.txt` file of the same release before you extract it.
If `python3.12` or the driver does not meet the requirement, the run is BLOCKED. Terminate the Pod and report it.

Make the run user and close the credential paths. These are the only host changes:

```sh
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aigg-l0
id aigg-l0
chmod 700 /root
[ -e /etc/rp_environment ] && chmod 600 /etc/rp_environment
stat -c '%a %U %n' / /workspace
```

`id aigg-l0` must show only the group `aigg-l0`. `/etc/rp_environment` can hold Pod variables such as an API key: the run user must not read it.
`/workspace` must belong to root and must not be writable by group or others. If it is, run `chmod go-w /workspace`.
Do not give the run user a password, sudo rights, or an SSH key. Do not run privileged containers, Docker, or firewall commands.

## 3. Copy the bundle and the input (G1)

From your computer:

```sh
scp -P <PORT> -i ~/.ssh/<key> -r <bundle> root@<IP>:/workspace/l0-1-bundle
scp -P <PORT> -i ~/.ssh/<key> l0-input-v1/concept-mirrored.png root@<IP>:/workspace/concept-mirrored.png
```

On the Pod:

```sh
chown -R root:root /workspace/l0-1-bundle /workspace/concept-mirrored.png
chmod -R go-w /workspace/l0-1-bundle && chmod 644 /workspace/concept-mirrored.png
mkdir -m 755 /workspace/l0-1
sh /workspace/l0-1-bundle/run.sh preflight --work /workspace/l0-1 --input /workspace/concept-mirrored.png
```

The expected result is INCOMPLETE (exit status 3): the code, wheels, models, and venv are missing. Every other check must be PASS. FAIL stops here.

## 4. Preparation (G2: downloads and offline installation)

```sh
sh /workspace/l0-1-bundle/run.sh prepare --work /workspace/l0-1
```

As root, it gets See-through at the pinned commit, 79 wheels (about 4.1 GB), and the model files (about 13.4 GB), and checks each file by size and hash.
As `aigg-l0`, it makes the venv and installs the wheels offline from the checked files. Then root takes the venv: the run user cannot change it later.
It does not run See-through. If it stops, run it again: it keeps the checked files and never replaces a file with other content.

Then check, without third-party code:

```sh
sh /workspace/l0-1-bundle/run.sh preflight --work /workspace/l0-1 --input /workspace/concept-mirrored.png
sh /workspace/l0-1-bundle/run.sh gpu --work /workspace/l0-1
sh /workspace/l0-1-bundle/run.sh isolation --work /workspace/l0-1
```

`preflight` must be READY (exit status 0) and `gpu` must be PASS.
`isolation` is ISOLATED (exit status 0) when the Pod allows a new network namespace for the run user. Then `qualify` and `run` have no network at the system level.
If it is UNAVAILABLE (exit status 3), `qualify` and `run` are BLOCKED. This is a decision for the owner, not a step to work around: stop here, or give `--accept-guard-only-network` to `qualify` and `run` (see SECURITY.md for what this mode does not protect).

**Stop point A.** You can stop here: collect the evidence (section 7) and terminate the Pod (section 8).

## 5. Environment qualification (G3)

```sh
sh /workspace/l0-1-bundle/run.sh qualify --work /workspace/l0-1
```

As `aigg-l0`, in the new network namespace, with the guard and offline settings, it imports each direct requirement, compares every installed distribution with the pins, and runs one small CUDA operation.
It loads no model file. The result is `evidence/qualify.json`. PASS (exit status 0) is necessary for `run`. FAIL stops here: report the problems in `qualify.json`.

**Stop point B.** You can stop here: collect the evidence (section 7) and terminate the Pod (section 8).

## 6. Inference (G4: the L0-1 run, once)

```sh
sh /workspace/l0-1-bundle/run.sh run --work /workspace/l0-1 --input /workspace/concept-mirrored.png
sh /workspace/l0-1-bundle/run.sh status --work /workspace/l0-1
ps -u aigg-l0
```

The run stops after 3600 s. The result is PASS or FAIL. Each problem has a code, for example `E_GUARD_DENIED` or `E_FALLBACK_SUSPECTED`.
`ps -u aigg-l0` must show no process. The runner kills all processes of the run user after the timeout or when you press Ctrl+C, and the result is then FAIL (`E_TIMEOUT` or `E_CANCELLED`).
If `ps -u aigg-l0` shows a process (for example after the SSH connection was lost), run `collect` (section 7): it kills them. Do not run it again in the same work directory. A second run is a new owner decision.

## 7. Collect the evidence (after every stop: PASS, FAIL, or BLOCKED)

On the Pod:

```sh
sh /workspace/l0-1-bundle/run.sh collect --work /workspace/l0-1
cd /workspace/l0-1 && tar -czf /workspace/l0-1-results.tar.gz evidence $( [ -d output ] && echo output )
tar -tzvf /workspace/l0-1-results.tar.gz
```

`collect` first kills every remaining process of `aigg-l0`. It refuses links, special files, and output files that are not PSD, PNG, or JSON, and writes `evidence/SHA256SUMS`.
The list from `tar -tzvf` must show only `evidence/...` and `output/...` entries: no `.safetensors`, no `.whl`, no `venv/`, no `hf/`, no `run/`. If it shows more, do not copy the archive. Report it.

On your computer:

```sh
scp -P <PORT> -i ~/.ssh/<key> root@<IP>:/workspace/l0-1-results.tar.gz .
mkdir l0-1-results && tar -xzf l0-1-results.tar.gz -C l0-1-results
cd l0-1-results && shasum -a 256 -c evidence/SHA256SUMS
```

`evidence/` can have `runner.log`, `git.log`, `install.log`, `isolation.json`, `qualify.json`, `qualify.log`, `qualify-guard.jsonl`, `result.json`, `guard.jsonl`, `see-through.log`, and `SHA256SUMS`. `output/` has the PSD files and the part images.
Put the archive in the project files. Do not commit it to Git.

## 8. Stop the Pod

Terminate the Pod (not only Stop). A stopped Pod keeps its volume and its cost. Check in the Runpod console that the Pod and its volume are gone.
Write down the end time and the cost.
