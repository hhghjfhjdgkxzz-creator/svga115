import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
    apiKey: "AIzaSyAVuLMxlidcKCvZP-Z8TXYC-kerA2s0GMo",
    authDomain: "svga1-bd95a.firebaseapp.com",
    projectId: "svga1-bd95a",
    storageBucket: "svga1-bd95a.firebasestorage.app",
    messagingSenderId: "975276355918",
    appId: "1:975276355918:web:9bcc4b3e18b0a533da6e1f"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);