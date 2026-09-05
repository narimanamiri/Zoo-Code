import * as fs from "fs/promises";
import * as path from "path";

import { SKILL_NAME_REGEX } from "@roo-code/types";

import { getGlobalRooDirectory } from "../roo-config";
import { safeWriteJson } from "../../utils/safeWriteJson";

import {
  fetchClusterSkill,
  fetchClusterSkillFile,
  fetchClusterSkills,
  type ClusterCredentials,
  type ClusterSkillSummary,
} from "./client";

/**
 * Skills the cluster has installed, mirrored onto this machine.
 *
 * The cluster injects a one-line router into every prompt and retrieves skill
 * sections into its own context — neither of which reaches an agent loop
 * running here. Without the files, this extension plans work against defaults
 * the cluster was configured to override, and the two disagree about how to
 * build a document or lay out an RTL page.
 *
 * They land in their own directory rather than in the user's global skills:
 * a name collision must never silently replace something the user wrote, and a
 * skill that has been deleted on the cluster has to be removable here without
 * guessing which files were theirs. The directory is registered as the
 * lowest-priority global source, so anything hand-written still wins.
 */

export const CLUSTER_SKILLS_DIRNAME = "cluster-skills";
const MANIFEST_NAME = ".cluster-manifest.json";

export const getClusterSkillsDirectory = (): string =>
  path.join(getGlobalRooDirectory(), CLUSTER_SKILLS_DIRNAME);

export type ClusterSkillsSyncResult = {
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  failed: { name: string; error: string }[];
};

type Manifest = {
  /** Where these came from, so a change of cluster is a full resync. */
  baseUrl: string;
  digests: Record<string, string>;
};

const emptyManifest = (baseUrl: string): Manifest => ({ baseUrl, digests: {} });

async function readManifest(directory: string): Promise<Manifest | undefined> {
  try {
    const raw = await fs.readFile(path.join(directory, MANIFEST_NAME), "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.baseUrl === "string"
    ) {
      return { baseUrl: parsed.baseUrl, digests: parsed.digests ?? {} };
    }
  } catch {
    // No manifest yet, or an unreadable one: treat as a first sync.
  }
  return undefined;
}

/**
 * A skill name is a directory name we are about to create from data a server
 * sent us, so it is validated against the same rule the extension applies to
 * hand-written skills rather than trusted.
 */
const isSafeSkillName = (name: string): boolean =>
  SKILL_NAME_REGEX.test(name) && name.length <= 64;

/**
 * A bundled path is relative, uses forward slashes, and may not climb out of
 * the skill directory. Everything else is dropped — one traversal here would
 * let a compromised or misconfigured cluster write anywhere the editor can.
 */
const isSafeRelativePath = (relative: string): boolean => {
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.includes("\0")
  ) {
    return false;
  }
  const segments = relative.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
};

const containedPath = (root: string, relative: string): string | undefined => {
  const target = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix) ? target : undefined;
};

async function writeSkill(
  directory: string,
  credentials: ClusterCredentials,
  summary: ClusterSkillSummary,
): Promise<void> {
  const detail = await fetchClusterSkill(credentials, summary.name);
  const skillDir = path.join(directory, summary.name);

  // Assembled beside the live copy and swapped in whole. The first version
  // deleted the old skill before fetching the new one, so one bundled file
  // failing to download left no skill at all until the next sync — and the
  // manifest, keeping the old digest, then re-downloaded a skill the
  // extension had already stopped seeing. Replace rather than merge is still
  // the rule: a file removed on the cluster must not linger here.
  const staging = path.join(
    directory,
    `.staging-${summary.name}-${process.pid}-${Date.now()}`,
  );
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  try {
    for (const file of detail.files) {
      if (!isSafeRelativePath(file.path)) {
        continue;
      }
      const target = containedPath(staging, file.path);
      if (!target) {
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (typeof file.text === "string") {
        await fs.writeFile(target, file.text, "utf-8");
      } else {
        const raw = await fetchClusterSkillFile(
          credentials,
          summary.name,
          file.path,
        );
        await fs.writeFile(target, raw);
      }
    }
    // Last, so a scan that catches the staging directory mid-write finds no
    // SKILL.md in it and skips it as an ordinary folder.
    await fs.writeFile(path.join(staging, "SKILL.md"), detail.content, "utf-8");

    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.rename(staging, skillDir);
  } catch (error) {
    await fs
      .rm(staging, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Mirror the cluster's skills into the local cache.
 *
 * Digest-driven: unchanged skills are not re-downloaded, so this is cheap
 * enough to run on activation. A skill that fails is reported and left as it
 * was — one bad SKILL.md must not wipe the rest.
 */
export async function syncClusterSkills(
  credentials: ClusterCredentials,
): Promise<ClusterSkillsSyncResult> {
  const result: ClusterSkillsSyncResult = {
    added: [],
    updated: [],
    unchanged: [],
    removed: [],
    failed: [],
  };
  const directory = getClusterSkillsDirectory();

  const remote = await fetchClusterSkills(credentials);
  await fs.mkdir(directory, { recursive: true });

  const previous = await readManifest(directory);
  // A different cluster is a different set of skills; anything cached under
  // the old address is not ours to keep. Skills the new cluster also has are
  // left in place and re-downloaded below (the empty manifest guarantees
  // that); the ones it does not have are removed now — the first version
  // forgot them, and a laptop moved between two clusters kept both sets.
  const remoteNames = new Set(remote.map((entry) => entry.name));
  if (previous && previous.baseUrl !== credentials.baseUrl) {
    for (const name of Object.keys(previous.digests)) {
      if (remoteNames.has(name) || !isSafeSkillName(name)) {
        continue;
      }
      const target = containedPath(directory, name);
      if (target) {
        await fs.rm(target, { recursive: true, force: true });
        result.removed.push(name);
      }
    }
  }
  const manifest =
    previous && previous.baseUrl === credentials.baseUrl
      ? previous
      : emptyManifest(credentials.baseUrl);
  const digests: Record<string, string> = {};

  for (const summary of remote) {
    if (!isSafeSkillName(summary.name)) {
      result.failed.push({ name: summary.name, error: "invalid skill name" });
      continue;
    }

    const digest = summary.digest ?? "";
    const known = manifest.digests[summary.name];
    const present = await fs
      .stat(path.join(directory, summary.name, "SKILL.md"))
      .then(() => true)
      .catch(() => false);

    if (present && known && digest && known === digest) {
      result.unchanged.push(summary.name);
      digests[summary.name] = digest;
      continue;
    }

    try {
      await writeSkill(directory, credentials, summary);
      digests[summary.name] = digest;
      (present ? result.updated : result.added).push(summary.name);
    } catch (error) {
      result.failed.push({
        name: summary.name,
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep the old digest so a later run retries rather than assuming success.
      if (known) {
        digests[summary.name] = known;
      }
    }
  }

  // Only remove what this sync put there. Anything else in the directory was
  // not ours, and deleting it would be a surprise.
  for (const name of Object.keys(manifest.digests)) {
    if (remoteNames.has(name) || !isSafeSkillName(name)) {
      continue;
    }
    const target = containedPath(directory, name);
    if (!target) {
      continue;
    }
    await fs.rm(target, { recursive: true, force: true });
    result.removed.push(name);
    delete digests[name];
  }

  await safeWriteJson(path.join(directory, MANIFEST_NAME), {
    baseUrl: credentials.baseUrl,
    digests,
  });
  return result;
}

/** Drop the whole mirror — used when the user turns skill syncing off. */
export async function clearClusterSkills(): Promise<void> {
  await fs.rm(getClusterSkillsDirectory(), { recursive: true, force: true });
}
