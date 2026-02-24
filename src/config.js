import path from "node:path";

const backendBaseUrl = "http://localhost:3001";
const INSTA_USER_LIST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXJ2aWNlIjoiZXh0ZXJuYWwtc2VydmljZSIsImlhdCI6MTc2OTUyMzIzOSwiZXhwIjoxNzcyMTE1MjM5fQ.8UOhvJ-QBbsrod_gn-h0Z0uHz86MvDXBe4LIPeCTv1A";
const REDIS_URL = "redis://default:7I25uyDoafmt6JmeaOuQgeMRZO7gKtRu@redis-17270.c277.us-east-1-3.ec2.cloud.redislabs.com:17270";
const HEADFUL = "1";
const DEBUG_LOGIN = "0";
const PROFILE_DIR = "./chrome-profile";
const TARGET_URL = "https://www.instagram.com/";
const DOWNLOAD_DIR = path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), "Downloads");

const config = {
    backendBaseUrl: backendBaseUrl.replace(/\/$/, ""),
    instaUserListToken: INSTA_USER_LIST_TOKEN,
    redisUrl: REDIS_URL,
    headful: HEADFUL,
    debugLogin: DEBUG_LOGIN,
    profileDir: PROFILE_DIR,
    targetUrl: TARGET_URL,
    downloadDir: DOWNLOAD_DIR,
};

config.instaUserListApiUrl = `${backendBaseUrl}/api/v1/external/getProfileInstaUserList`;
config.getFailedMediaCodesApiUrl = `${backendBaseUrl}/api/v1/external/getFailedMediaCodes`;
config.uploadMediaApiUrl = `${backendBaseUrl}/api/v1/external/upload/media`;
config.updateProfileBaseUrl = `${backendBaseUrl}/api/v1/external/updateProfileById`;
config.updatePostsBaseUrl = `${backendBaseUrl}/api/v1/external/updateContentById`;
config.batchSyncRetriedMediaApiUrl = `${backendBaseUrl}/api/v1/external/batchSyncRetriedmedia`;
config.batchUpdateVideoUrlsApiUrl = `${backendBaseUrl}/api/v1/external/batchUpdateVideoUrls`;

export default config;
