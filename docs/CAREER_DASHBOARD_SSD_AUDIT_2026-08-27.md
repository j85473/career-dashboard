# Career Dashboard SSD audit — 2026-08-27

## Current production placement

- PostgreSQL 17 stores the live database at `/mnt/pgdata/main` on the PNY 250 GB SATA SSD.
- The application release at `/opt/career-dashboard` remains on the microSD root filesystem.
- Keeping PostgreSQL on the SSD is the important placement for interactive page performance. Moving the small application release would mainly affect deployment, restart, and cold static-file reads.

## Verified SSD path

The PNY device is connected over a 5 Gbps USB 3 bus, but the active adapter path exposes these limits:

- Linux reports the device as rotational (`rotational=1`).
- The device uses the `usb-storage` driver rather than UAS.
- The bridge advertises no discard/TRIM capability (`DISC-MAX=0B`).
- The ext4 mount uses `relatime`.
- Weekly `fstrim.timer` is enabled, but the bridge cannot pass discard commands while it advertises zero discard capability.

These are adapter/kernel-interface facts, not PostgreSQL placement failures. The repository now runs `scripts/deployment/audit-storage.sh` during every deployment so a hardware or kernel change becomes visible in the deployment receipt.

## Safe disposition

No automatic host mutation is appropriate for the current adapter:

- Forcing UAS when the bridge is using `usb-storage` can destabilize I/O if the device was quirked for compatibility.
- Writing `rotational=0` in `/sys` would be temporary and would misrepresent the adapter until UAS behavior is proven.
- Enabling continuous discard or treating `fstrim` as effective while `DISC-MAX=0B` would create false confidence.
- Rewriting `/etc/fstab` for `noatime` offers little benefit compared with the application/query repairs and adds boot/mount risk.

The physical follow-up is to use a Raspberry Pi-compatible UAS USB-to-SATA adapter that passes TRIM, then rerun the deployment audit. Until then, PostgreSQL remains correctly placed on the SSD and the software performance work should focus on bounded queries, payloads, caching, indexing, and connection pools.
