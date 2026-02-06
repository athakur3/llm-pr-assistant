import { Octokit } from "@octokit/rest";

type CreatePrRequest = {
  token: string;
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
};

export async function createPullRequest({
  token,
  owner,
  repo,
  title,
  head,
  base,
  body,
}: CreatePrRequest): Promise<string> {
  const octokit = new Octokit({ auth: token });

  const response = await octokit.pulls.create({
    owner,
    repo,
    title,
    head,
    base,
    body,
  });

  return response.data.html_url;
}

