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
        populateTables(schedule);
        loadProgressLocal(schedule);
    })
    .catch(error => console.error("Error loading schedule:", error));

// Populate Tables with Schedule
function populateTables(schedule) {
    const localTableBody = document.getElementById("localTable").querySelector("tbody");
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
                    <input type="checkbox" id="localCheck${index}" onclick="saveProgressLocal(${index})">
                </td>
            </tr>
        `;
        localTableBody.innerHTML += row;

        const firebaseRow = `
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
        firebaseTableBody.innerHTML += firebaseRow;
    });
}

// Save Progress to Local Storage
function saveProgressLocal(index) {
    const checkbox = document.getElementById(`localCheck${index}`);
    localStorage.setItem(`localProgress${index}`, checkbox.checked);
}

// Load Progress from Local Storage
function loadProgressLocal(schedule) {
    schedule.forEach((_, index) => {
        const checkbox = document.getElementById(`localCheck${index}`);
        const savedProgress = localStorage.getItem(`localProgress${index}`);
        if (savedProgress === "true") {
            checkbox.checked = true;
        }
    });
}

// Firebase Save/Load Logic (optional)
function saveProgressFirebase(index) {
    const checkbox = document.getElementById(`firebaseCheck${index}`);
    const isChecked = checkbox.checked;
    const progressRef = firebase.database().ref(`progress/day${index}`);
    progressRef.set(isChecked);
}

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
