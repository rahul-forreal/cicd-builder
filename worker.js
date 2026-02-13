import {redis} from "./redisClient.js";
import { runPipeline } from "./pipeline.js";
import sqlite3 from "sqlite3";
import {open} from "sqlite";
import "dotenv/config";

async function openDB(){
    return open({
        filename:"history.db",
        driver:sqlite3.Database
    });
}

console.log("CI worker started. Waiting for jobs...");

while(true){
try {
    const result = await redis.brPop("ci:jobs",0);
    const jobId = result.element;

    const db = await openDB();
    const job=await db.get(`SELECT status, attempts, max_attempts FROM jobs WHERE id=?`,[jobId]);

    if(!job){
        console.log(`job ${jobId} not found, skipping`);
        continue;
    }

    if(job.attempts >= job.max_attempts){
        console.log(`job ${jobId} has exceeded retry limit!`);
        continue;
    }

    await db.run(`UPDATE jobs SET attempts=attempts+1 WHERE id=?`,[jobId]);
    
    console.log(`Running job ${jobId} (attempt ${job.attempts+1})`);

    const lockKey = `lock:job:${jobId}`;
    const locked = await redis.set(lockKey,"1",{
        NX:true,
        EX:300
    });
    if(!locked){
        console.log(`Job ${jobId} already running, skipping`);
        continue;
    }

    await runPipeline({jobId});

    await redis.del(lockKey);
} catch (error) {
    console.error("worker error",error);
}
}