export type PullRequest = {
  number: number;
  title: string;
  body: string;
  author: string;
  head: string;
  base: string;
  labels: string[];
  url: string;
  state: string;
  createdAt: string;
};

export type Issue = {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  url: string;
  state: string;
  createdAt: string;
};
