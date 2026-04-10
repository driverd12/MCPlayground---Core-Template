#!/usr/bin/env node
import process from "node:process";
import { spawnStreaming } from "./cross_platform_exec.mjs";

const testSuites = [
  ["-m", "unittest", "discover", "-s", "bridges", "-p", "test_*.py"],
  ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
];

const env = {
  ...process.env,
  PYTHONWARNINGS: process.env.PYTHONWARNINGS || "ignore::ResourceWarning",
};

for (const args of testSuites) {
  const result = spawnStreaming("python3", args, { env, cwd: process.cwd() });
  if (result.signal) {
    process.stderr.write(`run_python_tests.mjs: python test suite terminated by signal ${result.signal}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
