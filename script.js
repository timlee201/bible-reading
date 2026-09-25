const firebaseConfig = {
    apiKey: "AIzaSyA5KVNtwdH0vjTyHwpHVPqf5tNOVUeOxbA",
    authDomain: "biblereadingapp-a3c7a.firebaseapp.com",
    databaseURL: "https://biblereadingapp-a3c7a-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "biblereadingapp-a3c7a",
    storageBucket: "biblereadingapp-a3c7a.firebasestorage.app",
    messagingSenderId: "368092993348",
    appId: "1:368092993348:web:478a0cb7825979fa68e911"
};

const STORAGE_KEY = "nt-reading-progress";
let database = null;

try {
    if (typeof firebase !== "undefined") {
        firebase.initializeApp(firebaseConfig);
        database = firebase.database();
    }
} catch (error) {
    console.error("Firebase unavailable, using this device only:", error);
    database = null;
}

const statusEl = document.getElementById("status");
const listEl = document.getElementById("schedule");
const toggleDetailsBtn = document.getElementById("toggleDetails");

toggleDetailsBtn.addEventListener("click", () => {
    const showing = listEl.classList.toggle("show-details");
    toggleDetailsBtn.textContent = showing
        ? "Hide chapter and verse counts"
        : "Show chapter and verse counts";
});

function readLocal() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
        return {};
    }
}

function writeLocal(progress) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}

function applyProgress(progress) {
    Object.keys(progress).forEach(key => {
        const checkbox = document.getElementById(`check${key}`);
        if (checkbox) checkbox.checked = Boolean(progress[key]);
    });
}

function saveProgress(index) {
    const checkbox = document.getElementById(`check${index}`);
    const progress = readLocal();
    progress[index] = checkbox.checked;
    writeLocal(progress);
    if (database) {
        database.ref(`progress/day${index}`).set(checkbox.checked).catch(error => {
            console.error("Could not save progress online:", error);
        });
    }
}

function loadProgress() {
    applyProgress(readLocal());
    if (!database) return;
    database.ref("progress").once("value")
        .then(snapshot => {
            const progress = snapshot.val();
            if (!progress) return;
            const normalized = {};
            Object.keys(progress).forEach(key => {
                normalized[key.replace("day", "")] = progress[key];
            });
            writeLocal({ ...readLocal(), ...normalized });
            applyProgress(normalized);
        })
        .catch(error => {
            console.error("Could not load online progress:", error);
        });
}

function render(schedule) {
    listEl.innerHTML = "";
    schedule.forEach((item, index) => {
        const row = document.createElement("li");
        row.className = "day";
        row.innerHTML = `
            <label>
                <input type="checkbox" id="check${index}">
                <span class="reading">
                    <span class="meta">${item.date} · ${item.day}</span>
                    <span class="chapters">${item.chapters}</span>
                    <span class="details">${item.numChapters} chapters · ${item.verses} verses</span>
                </span>
            </label>
        `;
        row.querySelector("input").addEventListener("change", () => saveProgress(index));
        listEl.appendChild(row);
    });
}

fetch("schedule.json")
    .then(response => {
        if (!response.ok) throw new Error(`Schedule request failed (${response.status})`);
        return response.json();
    })
    .then(schedule => {
        if (!Array.isArray(schedule) || schedule.length === 0) {
            throw new Error("Schedule is empty");
        }
        render(schedule);
        loadProgress();
    })
    .catch(error => {
        console.error("Error loading schedule:", error);
        statusEl.hidden = false;
        statusEl.textContent = "The reading list could not be loaded.";
    });
