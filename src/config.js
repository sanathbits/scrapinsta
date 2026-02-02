const backendBaseUrl = process.env.BACKEND_BASE_URL || "https://uat-viralx.enpointe.io";

const config = {
  backendBaseUrl: backendBaseUrl.replace(/\/$/, ""),
};

config.instaUserListApiUrl = `${config.backendBaseUrl}/api/v1/external/getProfileInstaUserList`;
config.uploadMediaApiUrl = `${config.backendBaseUrl}/api/v1/external/upload/media`;
config.updateProfileBaseUrl = `${config.backendBaseUrl}/api/v1/external/updateProfileById`;
config.updatePostsBaseUrl = `${config.backendBaseUrl}/api/v1/external/updateContentById`;

export default config;
