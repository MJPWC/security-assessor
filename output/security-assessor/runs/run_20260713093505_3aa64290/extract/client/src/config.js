const getApiBaseUrl = () => {
  if (process.env.REACT_APP_API_BASE_URL) {
    return process.env.REACT_APP_API_BASE_URL;
  }

  const { protocol, hostname } = window.location;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

  if (isLocalhost) {
    return `${protocol}//${hostname}:5001`;
  }

  return window.location.origin;
};

const API_BASE_URL = getApiBaseUrl();

export default API_BASE_URL;
