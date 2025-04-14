import * as core from "@actions/core";
import * as github from "@actions/github";
import { exec } from "@actions/exec";
import { graphql } from "@octokit/graphql";
import * as fs from "node:fs";
import * as process from "node:process";

export async function commitWithGraphqlApi({
  commitMessage,
  repo,
  branch,
}: {
  commitMessage: string;
  repo: string;
  branch: string;
}) {
  try {
    // 1) Ensure we have a GitHub token
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      core.setFailed("GITHUB_TOKEN environment variable must be set");
      return;
    }

    if (!commitMessage) {
      core.setFailed("A commit message is required.");
      return;
    }

    // 2) Collect changed files using Git
    const filePatterns = ["**/package.json", "**/CHANGELOG.md", ".changeset/*"];
    const workspace = process.env.GITHUB_WORKSPACE || "/github/workspace";
    if (!process.env.GITHUB_WORKSPACE) {
      core.warning(
        "GITHUB_WORKSPACE is not set. Falling back to default: /github/workspace"
      );
    }

    // Make sure Git sees our workspace as safe
    await exec("git", [
      "config",
      "--global",
      "--add",
      "safe.directory",
      workspace,
    ]);

    const gitStatusOutput = await getGitStatus(filePatterns);
    // Parse the porcelain output to gather additions and deletions
    const adds: string[] = [];
    const deletes: string[] = [];

    for (const line of gitStatusOutput.split("\0")) {
      if (!line) continue;

      const indexStatus = line[0];
      const treeStatus = line[1];
      const filename = line.slice(3);
      core.info(
        `Filename: ${filename} (index=${indexStatus}, tree=${treeStatus})`
      );

      if (
        ["A", "M", "T"].includes(treeStatus) ||
        ["A", "M", "T"].includes(indexStatus)
      ) {
        adds.push(filename);
      }

      if (["D"].includes(treeStatus) || ["D"].includes(indexStatus)) {
        deletes.push(filename);
      }
    }

    if (adds.length === 0 && deletes.length === 0) {
      core.info("No changes detected. Exiting without commit.");
      return;
    }

    // 3) Perform the GraphQL commit
    // Prepare base64-encoded contents for all added files
    const additions = await Promise.all(
      adds.map(async (filePath) => ({
        path: filePath,
        contents: await base64EncodeFile(filePath),
      }))
    );
    // Deletions are trivial to represent
    const deletions = deletes.map((filePath) => ({ path: filePath }));

    const graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${githubToken}`,
      },
    });

    let expectedHeadOid = github.context.sha;
    if (!expectedHeadOid) {
      // fallback to local HEAD
      expectedHeadOid = await getLocalHeadSHA();
    }

    // Prepare commit message parts
    const [headline, body] = parseMessage(commitMessage);

    // Execute the GraphQL mutation
    const mutation = `
      mutation createCommitOnBranch($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) {
          commit {
            url
          }
        }
      }
    `;
    const input = {
      branch: {
        repositoryNameWithOwner: repo,
        branchName: branch,
      },
      message: {
        headline,
        body,
      },
      fileChanges: {
        additions,
        deletions,
      },
      expectedHeadOid,
    };

    core.info(`Creating commit on ${repo}@${branch}...`);
    const response = await graphqlWithAuth<{
      createCommitOnBranch: { commit: { url: string } };
    }>(mutation, { input });

    const commitUrl = response.createCommitOnBranch.commit.url;
    core.info(`Success! New commit: ${commitUrl}`);
  } catch (error: any) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Retrieve the git status in a machine-readable format
 */
async function getGitStatus(filePatterns: string[]): Promise<string> {
  // -s => short format
  // --porcelain=v1 => stable, script-friendly
  // -z => separate entries with null characters
  const args = ["status", "-s", "--porcelain=v1", "-z", "--", ...filePatterns];
  return execCommand("git", args);
}

/**
 * Helper to run a shell command with GitHub Action's tooling
 */
function execCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let error = "";

    const options = {
      listeners: {
        stdout: (data: Buffer) => (output += data.toString()),
        stderr: (data: Buffer) => (error += data.toString()),
      },
    };

    exec(command, args, options)
      .then(() => resolve(output))
      .catch((err) => reject(new Error(`${err.message}\n${error}`)));
  });
}

/**
 * Reads a file and returns its base64-encoded contents.
 */
async function base64EncodeFile(filePath: string): Promise<string> {
  try {
    const fileContent = await fs.promises.readFile(filePath);
    return fileContent.toString("base64");
  } catch (error) {
    core.error(
      `Failed to read file: ${filePath}. Error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw new Error(`Unable to encode file: ${filePath}`);
  }
}

/**
 * Splits a commit message into [headline, body].
 * If there is only one line, body will be "".
 */
function parseMessage(msg: string): [string, string] {
  const parts = msg.split("\n", 2);
  return [parts[0], parts[1] ?? ""];
}

async function getLocalHeadSHA(): Promise<string> {
  let headSha = "";
  const options = {
    listeners: {
      stdout: (data: Buffer) => {
        headSha += data.toString();
      },
    },
  };
  await exec("git", ["rev-parse", "HEAD"], options);
  return headSha.trim();
}
