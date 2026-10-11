import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg"

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..","..", "migrations");

export async function migrate(databaseUrl:string): Promise<void>{
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();


    try{
        //Only one migrator at a time, even if two processes start together
        await client.query("SELECT pg_advisory_lock(hashText('schema_migration'))");
       
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migration(
                version TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
 
        const { rows } = await client.query<{version:string}>(
            "SELECT version FROM schema_migration",
        );
        const applied = new Set(rows.map((r)=>r.version))

        const files = (await readdir(MIGRATIONS_DIR))
        .filter((f)=>f.endsWith(".sql")).sort();
        //file here is the fileName not the file with content
        for (const file of files){
            if(applied.has(file)) continue;
            const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
            await client.query("BEGIN");
            try{
                await client.query(sql);
                await client.query("INSERT INTO schema_migration (version) VALUES ($1)",[file]);
                await client.query("COMMIT");
                console.log(`applied ${file}`);
            }catch(err){
                await client.query("ROLLBACK");
                throw new Error(`migration ${file} failed`, { cause: err });
            }
        }
    }finally{
        await client.end(); //closing the sesssion, also releases the advisory lock
    }   
}

