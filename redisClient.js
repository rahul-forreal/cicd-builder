import { createClient } from "redis";

export const redis=createClient();

redis.on("error",(err)=>{
    console.error("redis error",err);
});
await redis.connect();