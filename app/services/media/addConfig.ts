import fs  from "fs/promises";
export function addWorldConfig(dirPath:string,config:{dirName:string, dirPath:string, dirUrl:string}&Record<string,string|number|boolean>) {
  
  let str = '';

  for (const p in config) {
    // if(['dirName','dirPath','dirUrl'].includes(p)) continue
    str += `\t${p}:${JSON.stringify(config[p])},\n`
  }
  
    fs.writeFile(
        `${dirPath}/world_config.js`,
        `
import {world_config as config} from '../../../public/world_config.js';
export const world_config = {
    url:"config.base + "${config.dirUrl}",
${str}
}
        ` 
        );
}