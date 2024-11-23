// Firebase configuration using CDN scripts
const firebaseConfig = {
    apiKey: "AIzaSyA5KVNtwdH0vjTyHwpHVPqf5tNOVUeOxbA",
    authDomain: "biblereadingapp-a3c7a.firebaseapp.com",
    databaseURL: "https://biblereadingapp-a3c7a-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "biblereadingapp-a3c7a",
    storageBucket: "biblereadingapp-a3c7a.firebasestorage.app",
    messagingSenderId: "368092993348",
    appId: "1:368092993348:web:478a0cb7825979fa68e911"
};

// Initialize Firebase
const app = firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// Initialize collapsible sections
const collapsibles = document.querySelectorAll(".collapsible");
collapsibles.forEach(button => {
    button.addEventListener("click", function () {
        this.classList.toggle("active");
        const content = this.nextElementSibling;
        if (content.style.display === "block") {
            content.style.display = "none";
        } else {
            content.style.display = "block";
        }
    });
});

// Load schedule from schedule.json
fetch("schedule.json")
    .then(response => response.json())
    .then(schedule => {
        populateFirebaseTable(schedule); // Populate table with schedule data
        loadProgressFirebase(schedule); // Load saved progress
    })
    .catch(error => console.error("Error loading schedule:", error));

// Populate Firebase Table
function populateFirebaseTable(schedule) {
    const firebaseTableBody = document.getElementById("firebaseTable").querySelector("tbody");

    schedule.forEach((item, index) => {
        const row = `
            <tr>
                <td>${item.date}</td>
                <td>${item.day}</td>
                <td>${item.chapters}</td>
                <td class="chapters hidden">${item.numChapters}</td>
                <td class="verses hidden">${item.verses}</td>
                <td class="icon-column">
                    <input type="checkbox" id="firebaseCheck${index}" onclick="saveProgressFirebase(${index})">
                </td>
            </tr>
        `;
        firebaseTableBody.innerHTML += row;
    });
}

// Save Progress to Firebase
function saveProgressFirebase(index) {
    const checkbox = document.getElementById(`firebaseCheck${index}`);
    const isChecked = checkbox.checked;
    const progressRef = firebase.database().ref(`progress/day${index}`);
    progressRef.set(isChecked);
}

// Load Progress from Firebase
function loadProgressFirebase(schedule) {
    const progressRef = firebase.database().ref('progress');
    progressRef.once('value', snapshot => {
        const progress = snapshot.val();
        if (progress) {
            Object.keys(progress).forEach(key => {
                const index = key.replace('day', '');
                const checkbox = document.getElementById(`firebaseCheck${index}`);
                if (checkbox) checkbox.checked = progress[key];
            });
        }
    });
}

// Toggle visibility of columns
function toggleColumn(section, columnClass) {
    const elements = document.querySelectorAll(`#${section}Table .${columnClass}`);
    elements.forEach(element => {
        element.classList.toggle('hidden');
    });
}
