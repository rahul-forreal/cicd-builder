import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import {redis} from "./redisClient.js";

/* ---------------- DB ---------------- */

async function openDB() {
  return open({
    filename: "history.db",
    driver: sqlite3.Database
  });
}

/* ---------------- LOG CAPTURE ---------------- */

function loadCiConfig(workspacePath){
  const configPath=path.join(workspacePath,".cicd.json");
  const defaultConfig={
    install:true,
    test:true,
    build:true,
    deploy:true
  };

  if(!fs.existsSync(configPath)){
    return defaultConfig;
  }
  try {
    const raw=fs.readFileSync(configPath,"utf-8");
    return {...defaultConfig,...JSON.parse(raw)};
  } catch (error) {
    console.log("Invalid .cicd.json, using defaults!");
    return defaultConfig;
  }
}

function runAndCapture(cmd, jobId, db) {
  try {
    const output = execSync(cmd, { encoding: "utf-8" });

    db.run(
      `UPDATE jobs SET logs = COALESCE(logs, '') || ? WHERE id = ?`,
      [`\n$ ${cmd}\n${output}`, jobId]
    );

    return output;
  } catch (err) {
    const errorOutput =
      (err.stdout || "") +
      (err.stderr || "") +
      (err.message || "");

    db.run(
      `UPDATE jobs SET logs = COALESCE(logs, '') || ? WHERE id = ?`,
      [`\n$ ${cmd}\n${errorOutput}`, jobId]
    );

    throw err; // fail pipeline
  }
}

/* ---------------- PIPELINE ---------------- */

export async function runPipeline({jobId}) {
  const db = await openDB();

  const job=await db.get(
    `SELECT repo,branch,clone_url,commit_sha FROM jobs WHERE id = ?`,[jobId]  
  );
  if(!job){
    console.error(`job ${jobId} not found`);
    return;
  }
  const {repo,branch,clone_url:cloneUrl,commit_sha:commitSha}=job;

  const workspacePath = path.join("workspace", `job-${jobId}`);
  fs.mkdirSync(workspacePath, { recursive: true });

  try {
    // 2️⃣ Running
    await db.run(`UPDATE jobs SET status = 'running' WHERE id = ?`, [jobId]);
    // 3️⃣ Clone

    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }


    await db.run(`UPDATE jobs SET stage = 'clone' WHERE id = ?`, [jobId]);
    runAndCapture(`git clone ${cloneUrl} ${workspacePath}`, jobId, db);
    runAndCapture(`cd ${workspacePath} && git checkout ${commitSha}`,jobId,db);  
    // CI config
    const ciConfig = loadCiConfig(workspacePath);
    console.log("CI config:",ciConfig);
    // 4️⃣ Install
    if(ciConfig.install){
    await db.run(`UPDATE jobs SET stage = 'install' WHERE id = ?`, [jobId]);
    runAndCapture(
      `docker run --rm -v ${process.cwd()}/${workspacePath}:/app cicd-runner sh -c "npm install"`,
      jobId,
      db
    );
    }else{
    runAndCapture(`echo "SKIPPING install"`,jobId,db);
  }
    // 5️⃣ Tests (conditional)
    if (ciConfig.test) {
          await db.run(`UPDATE jobs SET stage = 'test' WHERE id = ?`, [jobId]);

    let hasTests = true;
    try {
      runAndCapture(
        `docker run --rm -v ${process.cwd()}/${workspacePath}:/app cicd-runner sh -c "npm run | grep test"`,
        jobId,
        db
      );
    } catch {
      hasTests = false;
    }

    if (hasTests) {
      runAndCapture(
        `docker run --rm -v ${process.cwd()}/${workspacePath}:/app cicd-runner sh -c "npm test"`,
        jobId,
        db
      );
    } else {
      runAndCapture(`echo "No tests found, skipping"`, jobId, db);
    }
    } else {
      runAndCapture(`echo "SKIPPING tests"`,jobId,db);
    }

    // 6️⃣ Build
    if (ciConfig.build) {
      await db.run(`UPDATE jobs SET stage = 'build' WHERE id = ?`, [jobId]);
      runAndCapture(
      `docker run --rm -v ${process.cwd()}/${workspacePath}:/app cicd-runner sh -c "npm run build"`,
      jobId,
      db
    );
    } else {
      runAndCapture(`echo "SKIPPING build"`,jobId,db);
    }

    // 7️⃣ Deploy
    if (ciConfig.deploy) {
      await db.run(`UPDATE jobs SET stage = 'deploy' WHERE id = ?`, [jobId]);
      runAndCapture(`bash deploy.sh ${repo} ${commitSha} ${workspacePath}`, jobId, db);
    } else {
      runAndCapture(`echo "SKIPPING deploy"`,jobId,db);
    }

    // 8️⃣ Success
    await db.run(
      `UPDATE jobs SET status = 'success', finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [jobId]
    );

    console.log(`🎉 Job ${jobId} completed successfully`);
  } catch (err) {
    await db.run(
      `UPDATE jobs SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [err.message, jobId]
    );

    const job= await db.get(`SELECT attempts, max_attempts FROM jobs WHERE id=?`,[jobId]);
    if(job.attempts < job.max_attempts){
      console.log(`Re-enqueueing job ${jobId} for retry`);
      await redis.lPush("ci:jobs",jobId.toString());
    }

    console.error(`❌ Job ${jobId} failed`);
  }
}

/* ---------------- APIs ---------------- */

export async function getJobs() {
  const db = await openDB();
  return db.all(
    `SELECT id, repo, branch, status, stage, error, triggered_at, finished_at
     FROM jobs
     ORDER BY id DESC`
  );
}

export async function getJobById(id) {
  const db = await openDB();
  return db.get(
    `SELECT id, repo, branch, status, stage, error, logs, triggered_at, finished_at
     FROM jobs
     WHERE id = ?`,
    [id]
  );
}
